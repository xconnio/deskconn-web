<script setup lang="ts">
/**
 * Multi-tab text editor window. Each tab streams content via file.cat (fileCat.ts)
 * and saves via file.edit as a diff-match-patch patch (see fileexplorer.go) once it
 * has a destination path — a brand-new untitled tab gets its first path through
 * file.upload instead (fileUpload.ts), since file.edit can only patch a file that
 * already exists. Git status/diff data comes from git.status/git.original
 * (filegit.go) — red/amber file tree entries mean "not committed yet"/"modified",
 * and a green/blue bar beside the line numbers means "added"/"modified" relative
 * to HEAD (lineDiff.ts).
 */
import { ref, reactive, computed, inject, watch, nextTick, onMounted, onUnmounted, shallowRef } from 'vue'
import { type Session } from 'xconn'
import { floatingWindowActionsKey, floatingWindowToolbarKey } from '@/composables/floatingWindowToolbar'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import type { CloseConfirm } from '@/composables/useWindowManager'
import EditorFileTree from '@/components/EditorFileTree.vue'
import GitFolderPicker from '@/components/GitFolderPicker.vue'
import TabStrip from '@/components/TabStrip.vue'
import { useSessionCacheStore } from '@/stores/sessionCache'
import { useSessionEncryptionStore } from '@/stores/sessionEncryption'
import { streamFileCat } from '@/utils/fileCat'
import { buildEditPatch } from '@/utils/textPatch'
import { downloadBlob } from '@/utils/download'
import { encryptPayload, decryptPayload, type EncryptionKeys } from '@/utils/encryption'
import { formatSize } from '@/utils/fileTypes'
import { formatDesktopError, isDesktopOfflineError, isEditConflictError } from '@/utils/desktopError'
import { createFileBrowser } from '@/utils/fileBrowse'
import { fetchGitOriginal } from '@/utils/git'
import { uploadFileToPath } from '@/utils/fileUpload'
import { notifyFileChanged } from '@/utils/fileChanges'
import { computeLineDiff, type LineDiffMap } from '@/utils/lineDiff'
import 'highlight.js/styles/monokai-sublime.css'

const procedureFileEdit = 'io.xconn.deskconn.file.edit'
const MAX_EDIT_SIZE = 10 * 1024 * 1024

type TextEntry = { path: string; name: string; size: number }

interface TabState {
  id: number
  entry: TextEntry | null
  content: string
  originalContent: string
  gitOriginalContent: string
  gitIsRepo: boolean
  gitUntracked: boolean
  gitIgnored: boolean
  gitBaselineLoaded: boolean
  loading: boolean
  loadedBytes: number
  loadError: string
  saving: boolean
  saveError: string
  saveConflict: boolean
  /** Single-click-opened tabs are reusable "preview" slots (VS Code style) —
   * the next single click replaces them instead of piling up a new tab, as
   * long as they're still clean. Double-clicking or editing promotes a tab
   * out of preview (see isReusablePreview). */
  isPreview: boolean
}

const props = defineProps<{
  session?: Session
  realm: string
  entry?: TextEntry
  initialFolder?: string
  focused?: boolean
}>()

const emit = defineEmits<{ 'update-title': [title: string]; close: [] }>()

const actionsHostRef = inject(floatingWindowActionsKey)
const actionsTarget = computed(() => actionsHostRef?.value ?? null)
const toolbarHostRef = inject(floatingWindowToolbarKey)
const toolbarTarget = computed(() => toolbarHostRef?.value ?? null)

const sessionEncryptionStore = useSessionEncryptionStore()
const sessionCacheStore = useSessionCacheStore()

// ── Session bootstrap ──────────────────────────────────────────────────────
// Launched from Files, TextEditor inherits an already-connected session; blank
// dock launches get none, so it acquires its own — same as EmbeddedDesktopFiles.
const ownSession = shallowRef<Session | null>(null)
const activeSession = computed(() => props.session ?? ownSession.value)
const initError = ref('')
const encryptionKeys = ref<EncryptionKeys | null>(null)
const fileBrowser = shallowRef<ReturnType<typeof createFileBrowser> | null>(null)

async function bootstrapSession() {
  if (!props.session) {
    try {
      ownSession.value = await sessionCacheStore.acquire(props.realm)
    } catch (err) {
      initError.value = formatDesktopError(err, 'Failed to connect to desktop')
      return
    }
  }
  const session = activeSession.value
  if (!session) return

  try {
    encryptionKeys.value = await sessionEncryptionStore.getOrExchange(session, props.realm)
  } catch (err) {
    if (isDesktopOfflineError(err)) sessionCacheStore.reportUnreachable(props.realm)
    initError.value = formatDesktopError(err, 'Failed to establish a secure session')
    return
  }
  fileBrowser.value = createFileBrowser(session, () => encryptionKeys.value)
}

// ── Tabs ────────────────────────────────────────────────────────────────────
const tabs = ref<TabState[]>([])
const activeTabId = ref<number | null>(null)
let nextTabId = 0
const loadControllers = new Map<number, AbortController>()

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)

function isDirty(tab: TabState): boolean {
  return tab.content !== tab.originalContent
}
const activeDirty = computed(() => (activeTab.value ? isDirty(activeTab.value) : false))
const anyDirty = computed(() => tabs.value.some(isDirty))

function tabLabel(tab: TabState): string {
  return tab.entry?.name ?? 'Untitled'
}

const stripTabs = computed(() => tabs.value.map((t) => ({
  id: t.id,
  label: tabLabel(t),
  dirty: isDirty(t),
  preview: t.isPreview,
})))

// reactive() here (not a plain object) so the reference held across the async
// gap in loadTabContent/performSave/etc. IS the reactive proxy itself — a
// plain object only becomes reactive when read back out of tabs.value, and
// mutating the pre-push reference instead bypasses Vue's change tracking
// entirely (the DOM only catches up on some later, unrelated re-render).
function createTab(entry: TextEntry | null, isPreview: boolean): TabState {
  return reactive({
    id: nextTabId++,
    entry,
    content: '',
    originalContent: '',
    gitOriginalContent: '',
    gitIsRepo: false,
    gitUntracked: false,
    gitIgnored: false,
    gitBaselineLoaded: !entry, // untitled tabs have no baseline to wait for
    loading: !!entry,
    loadedBytes: 0,
    loadError: '',
    saving: false,
    saveError: '',
    saveConflict: false,
    isPreview,
  })
}

// focusEditor=false keeps focus where it is, e.g. on the file tree so its
// arrow-key navigation keeps working after opening a file from it.
function switchTab(id: number, focusEditor = true) {
  activeTabId.value = id
  nextTick(() => {
    updateAvailableWidth()
    updateLineHeight()
    if (focusEditor) activeTextareaEl.value?.focus()
  })
}

function addBlankTab() {
  const tab = createTab(null, false)
  tabs.value.push(tab)
  switchTab(tab.id)
}

async function loadGitBaseline(tab: TabState) {
  const session = activeSession.value
  if (!tab.entry || !session || !encryptionKeys.value) {
    tab.gitBaselineLoaded = true
    return
  }
  try {
    const result = await fetchGitOriginal(session, encryptionKeys.value, tab.entry.path)
    tab.gitOriginalContent = result.is_new ? '' : result.content
    tab.gitIsRepo = result.is_repo
    tab.gitUntracked = result.untracked
    tab.gitIgnored = result.ignored
  } catch {
    tab.gitOriginalContent = ''
    tab.gitIsRepo = false
    tab.gitUntracked = false
    tab.gitIgnored = false
  } finally {
    tab.gitBaselineLoaded = true
  }
}

async function loadTabContent(tab: TabState) {
  const session = activeSession.value
  if (!tab.entry || !session) return

  tab.loading = true
  tab.loadError = ''
  tab.loadedBytes = 0
  tab.content = ''
  tab.gitBaselineLoaded = false

  // Entries opened by path (the Open File picker) don't know their size up
  // front — refresh it via a stat-only browse before the size gate below.
  let size = tab.entry.size
  if (size <= 0 && fileBrowser.value) {
    try {
      const browse = await fileBrowser.value.browseFiles(tab.entry.path)
      size = browse.size
      tab.entry = { ...tab.entry, size }
    } catch (err) {
      tab.loadError = err instanceof Error ? err.message : 'Failed to open file'
      tab.loading = false
      return
    }
  }

  if (size > MAX_EDIT_SIZE) {
    tab.loadError = `File is too large to edit (max ${formatSize(MAX_EDIT_SIZE)}).`
    tab.loading = false
    return
  }

  const controller = new AbortController()
  loadControllers.set(tab.id, controller)
  const decoder = new TextDecoder('utf-8', { fatal: false })

  try {
    await streamFileCat(session, props.realm, tab.entry.path, (chunk) => {
      tab.loadedBytes += chunk.length
      tab.content += decoder.decode(chunk, { stream: true })
    }, controller.signal)
    tab.content += decoder.decode()
    tab.originalContent = tab.content
  } catch (err) {
    tab.loadError = err instanceof Error ? err.message : 'Failed to load file'
  } finally {
    tab.loading = false
  }

  void loadGitBaseline(tab)
}

function findTabByPath(path: string): TabState | undefined {
  return tabs.value.find((t) => t.entry?.path === path)
}

/** pinned=false is a single click (preview, reused/replaced by the next one);
 * pinned=true is a double click or the Open File picker (always a real tab). */
// An untouched "Untitled" tab (the default blank tab a fresh window opens
// with, or one added via "New" and never typed in) isn't worth keeping
// around once a real file is opened — it gets replaced in place rather than
// left dangling next to a newly added tab.
function isReplaceableBlankTab(tab: TabState): boolean {
  return !tab.entry && !isDirty(tab)
}

function openFileInTab(target: TextEntry, pinned: boolean, focusEditor = true) {
  const existing = findTabByPath(target.path)
  if (existing) {
    if (pinned) existing.isPreview = false
    switchTab(existing.id, focusEditor)
    return
  }

  const active = activeTab.value
  const reusePreview = !pinned && active && active.isPreview && !isDirty(active)
  const reuseBlank = active && isReplaceableBlankTab(active)
  if (reusePreview || reuseBlank) {
    loadControllers.get(active.id)?.abort()
    active.entry = target
    active.isPreview = !pinned
    void loadTabContent(active)
    switchTab(active.id, focusEditor)
    return
  }

  const tab = createTab(target, !pinned)
  tabs.value.push(tab)
  switchTab(tab.id, focusEditor)
  void loadTabContent(tab)
}

// ── Closing tabs / the window ──────────────────────────────────────────────
type PendingClose = { kind: 'tab'; tab: TabState } | { kind: 'window'; resolve: (ok: boolean) => void }
const pendingClose = ref<PendingClose | null>(null)

const closeConfirmTitle = computed(() => {
  const p = pendingClose.value
  if (!p) return ''
  return p.kind === 'tab' ? `Close "${tabLabel(p.tab)}"?` : 'Unsaved changes'
})
const closeConfirmMessage = computed(() => {
  const p = pendingClose.value
  if (!p) return ''
  if (p.kind === 'tab') return `${tabLabel(p.tab)} has unsaved changes. Close this tab anyway?`
  return windowCloseMessage()
})
function windowCloseMessage() {
  const n = tabs.value.filter(isDirty).length
  return `${n} file${n === 1 ? '' : 's'} have unsaved changes. Close this window anyway?`
}

function closeTabImmediate(id: number) {
  loadControllers.get(id)?.abort()
  loadControllers.delete(id)
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return
  tabs.value.splice(idx, 1)
  if (activeTabId.value === id) {
    const next = tabs.value[idx] ?? tabs.value[idx - 1]
    activeTabId.value = next ? next.id : null
    if (next) nextTick(updateAvailableWidth)
  }
}

function requestCloseTab(id: number, e?: Event) {
  e?.stopPropagation()
  const tab = tabs.value.find((t) => t.id === id)
  if (!tab) return
  if (isDirty(tab)) {
    pendingClose.value = { kind: 'tab', tab }
    return
  }
  closeTabImmediate(id)
}

// Called by DesktopSessionHost before it unmounts this window.
async function requestClose(confirm?: CloseConfirm): Promise<boolean> {
  if (!anyDirty.value) return true
  if (confirm) return confirm('Unsaved changes', windowCloseMessage())
  return new Promise<boolean>((resolve) => {
    pendingClose.value = { kind: 'window', resolve }
  })
}
defineExpose({ requestClose })

function confirmPendingClose() {
  const p = pendingClose.value
  pendingClose.value = null
  if (!p) return
  if (p.kind === 'tab') closeTabImmediate(p.tab.id)
  else p.resolve(true)
}
function cancelPendingClose() {
  const p = pendingClose.value
  pendingClose.value = null
  if (p?.kind === 'window') p.resolve(false)
}

// ── Files menu (New / Open File / Open Folder / Save / Save As) ───────────
const filesMenuOpen = ref(false)
const filesMenuBtnRef = ref<HTMLElement | null>(null)
const filesMenuPos = ref<{ top: string; left: string }>({ top: '0px', left: '0px' })

function toggleFilesMenu() {
  if (filesMenuOpen.value) {
    filesMenuOpen.value = false
    return
  }
  const el = filesMenuBtnRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const menuWidth = 200
  filesMenuPos.value = {
    top: `${rect.bottom + 6}px`,
    left: `${Math.min(rect.left, window.innerWidth - menuWidth - 8)}px`,
  }
  filesMenuOpen.value = true
}
function closeFilesMenu() {
  filesMenuOpen.value = false
}

const openedFolderPath = ref('')
const openedFolderName = computed(() => openedFolderPath.value.split('/').filter(Boolean).pop() || openedFolderPath.value)

const SIDEBAR_MIN_WIDTH = 160
const SIDEBAR_MAX_WIDTH = 480
const sidebarWidth = ref(240)

function startSidebarResize(e: PointerEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = sidebarWidth.value

  function onMove(ev: PointerEvent) {
    const next = startWidth + (ev.clientX - startX)
    sidebarWidth.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next))
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

type PickerState = { mode: 'open-file' | 'open-folder' | 'save-as'; targetTab?: TabState; initialPath?: string }
const picker = ref<PickerState | null>(null)

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx > 0 ? path.slice(0, idx) : '/'
}

function openSaveAsPicker(tab: TabState) {
  const initialPath = tab.entry ? dirOf(tab.entry.path) : openedFolderPath.value || undefined
  picker.value = { mode: 'save-as', targetTab: tab, initialPath }
}

function menuNew() {
  closeFilesMenu()
  addBlankTab()
}
function menuOpenFile() {
  closeFilesMenu()
  picker.value = { mode: 'open-file', initialPath: openedFolderPath.value || undefined }
}
function menuOpenFolder() {
  closeFilesMenu()
  picker.value = { mode: 'open-folder', initialPath: openedFolderPath.value || undefined }
}
function menuSave() {
  closeFilesMenu()
  if (activeTab.value) void saveTab(activeTab.value)
}
function menuSaveAs() {
  closeFilesMenu()
  if (activeTab.value) openSaveAsPicker(activeTab.value)
}
// Detaches the sidebar's folder tree only — open tabs and the window itself
// are untouched, unlike Exit below.
function menuCloseProject() {
  closeFilesMenu()
  openedFolderPath.value = ''
}
function menuExit() {
  closeFilesMenu()
  emit('close')
}

function onPickerCancel() {
  picker.value = null
}
function onPickerConfirm(path: string) {
  const p = picker.value
  picker.value = null
  if (!p) return

  if (p.mode === 'open-folder') {
    openedFolderPath.value = path
  } else if (p.mode === 'open-file') {
    const name = path.split('/').pop() || path
    openFileInTab({ path, name, size: 0 }, true)
  } else if (p.mode === 'save-as' && p.targetTab) {
    void createNewFile(p.targetTab, path)
  }
}

function onTreeOpenFile(entry: { path: string; name: string; size: number }) {
  openFileInTab(entry, false, false)
}
function onTreeOpenFilePinned(entry: { path: string; name: string; size: number }) {
  openFileInTab(entry, true, false)
}

// ── Saving ──────────────────────────────────────────────────────────────────
const savedFlash = ref(false)
let savedFlashTimer: ReturnType<typeof setTimeout> | null = null
function flashSaved() {
  savedFlash.value = true
  if (savedFlashTimer) clearTimeout(savedFlashTimer)
  savedFlashTimer = setTimeout(() => { savedFlash.value = false }, 1800)
}

async function saveTab(tab: TabState) {
  if (!isDirty(tab) || tab.saving) return
  if (!tab.entry) {
    openSaveAsPicker(tab)
    return
  }
  await performSave(tab)
}

async function performSave(tab: TabState) {
  const session = activeSession.value
  if (!session || !tab.entry) return
  tab.saving = true
  tab.saveError = ''
  tab.saveConflict = false

  try {
    const patch = buildEditPatch(tab.originalContent, tab.content)
    const keys = await sessionEncryptionStore.getOrExchange(session, props.realm)
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ path: tab.entry.path, patch }))
    const encrypted = encryptPayload(payloadBytes, keys.encryptKey)

    const result = await session.call(procedureFileEdit, [encrypted])
    const encryptedResult = result.args?.[0]
    if (encryptedResult) decryptPayload(encryptedResult as Uint8Array, keys.decryptKey)

    tab.originalContent = tab.content
    notifyFileChanged(props.realm, tab.entry.path)
    flashSaved()
  } catch (err) {
    tab.saveConflict = isEditConflictError(err)
    if (isDesktopOfflineError(err)) sessionCacheStore.reportUnreachable(props.realm)
    tab.saveError = formatDesktopError(err, 'Failed to save file')
  } finally {
    tab.saving = false
  }
}

// file.edit only patches a file that already exists — a brand-new destination
// (first save of an untitled tab, or "Save As" to a new path) goes through
// file.upload instead, which creates-or-overwrites unconditionally.
async function createNewFile(tab: TabState, fullPath: string) {
  const session = activeSession.value
  if (!session) return
  const lastSlash = fullPath.lastIndexOf('/')
  const dir = lastSlash > 0 ? fullPath.slice(0, lastSlash) : '/'
  const name = fullPath.slice(lastSlash + 1)

  tab.saving = true
  tab.saveError = ''
  tab.saveConflict = false
  try {
    const blob = new Blob([tab.content], { type: 'text/plain' })
    await uploadFileToPath(session, props.realm, dir, name, blob)
    tab.entry = { path: fullPath, name, size: blob.size }
    tab.originalContent = tab.content
    void loadGitBaseline(tab)
    flashSaved()
  } catch (err) {
    tab.saveError = formatDesktopError(err, 'Failed to save file')
  } finally {
    tab.saving = false
  }
}

function downloadTab(tab: TabState) {
  downloadBlob(new Blob([tab.content], { type: 'text/plain' }), tabLabel(tab) === 'Untitled' ? 'untitled.txt' : tabLabel(tab))
}

async function reloadActiveTab() {
  const tab = activeTab.value
  if (!tab || !tab.entry) return
  if (isDirty(tab) && !window.confirm('Reload will discard your unsaved changes. Continue?')) return
  loadControllers.get(tab.id)?.abort()
  tab.saveError = ''
  tab.saveConflict = false
  await loadTabContent(tab)
}

// ── Gutter / wrap (unchanged algorithm from the single-file editor, just
// retargeted to whichever tab is currently active — only one tab is ever
// visible/interactive at a time, so one shared measurement is enough). ──────
// reactive() (not a plain Map) — activeTextareaEl below is read inside a
// watch(), which evaluates it eagerly on the "pre" flush, before the newly
// active tab's element has actually mounted. With a plain Map, that early
// read caches `null` and — since the computed's only tracked dependency is
// activeTabId, which doesn't change again while staying on the tab — it
// silently stays null forever (breaking scroll sync, word-wrap width, the
// Tab-key indent handler, and autofocus). A reactive Map makes `.set()`
// itself a trigger, so the computed invalidates correctly once the ref
// callback actually populates it.
const textareaElMap = reactive(new Map<number, HTMLTextAreaElement>())
const gutterElMap = reactive(new Map<number, HTMLElement>())
function setTextareaEl(id: number, el: Element | null) {
  if (el) textareaElMap.set(id, el as HTMLTextAreaElement)
  else textareaElMap.delete(id)
}
function setGutterEl(id: number, el: Element | null) {
  if (el) gutterElMap.set(id, el as HTMLElement)
  else gutterElMap.delete(id)
}

const activeTextareaEl = computed(() => (activeTabId.value !== null ? textareaElMap.get(activeTabId.value) ?? null : null))
const activeGutterEl = computed(() => (activeTabId.value !== null ? gutterElMap.get(activeTabId.value) ?? null : null))

// Bound to more than just @scroll (see the textarea in the template: also
// @input/@mousedown/@click/@keyup/@focus) — the browser scrolls a focused
// textarea to keep the caret in view on its own (arrow keys, Home/End,
// typing past the bottom edge, refocusing a tab) without reliably firing a
// 'scroll' event for it. If the gutter ever lags behind the textarea's real
// scrollTop even briefly, a click resolves against the textarea's actual
// (unsynced) scroll position rather than the line the user sees in the
// gutter — which reads as "typing lands on the wrong line". @mousedown
// matters most here since it fires before the browser turns the click into
// a caret position, so re-syncing there (not just after, on @click)
// corrects the gutter before that mapping happens, not just for the next
// interaction. Re-syncing on every interaction that could plausibly move
// the caret closes the window instead of chasing the exact browser trigger.
function syncGutterScroll() {
  const top = activeTextareaEl.value?.scrollTop ?? 0
  if (activeGutterEl.value) activeGutterEl.value.scrollTop = top
  if (activeHighlightEl.value) activeHighlightEl.value.scrollTop = top
}

// ── Syntax highlighting: a <pre> of highlight.js markup sits under a
// transparent-text textarea, wrapped and scrolled identically, so the caret,
// selection and editing stay the textarea's own.
type Hljs = typeof import('highlight.js').default
const hljs = shallowRef<Hljs | null>(null)
// Loaded on demand — the full build (~190 languages) is big.
void import('highlight.js').then((m) => { hljs.value = m.default })

const highlightElMap = reactive(new Map<number, HTMLElement>())
function setHighlightEl(id: number, el: Element | null) {
  if (el) highlightElMap.set(id, el as HTMLElement)
  else highlightElMap.delete(id)
}
const activeHighlightEl = computed(() => (activeTabId.value !== null ? highlightElMap.get(activeTabId.value) ?? null : null))
// A freshly shown layer (tab switch, highlighter just loaded) starts at the top.
watch(activeHighlightEl, syncGutterScroll)

// Whole file names, then extensions highlight.js has no alias for. Anything
// else is tried as an extension directly (py, go, rs, ts, dart, json…).
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', gnumakefile: 'makefile', 'cmakelists.txt': 'cmake',
  gemfile: 'ruby', rakefile: 'ruby', vagrantfile: 'ruby', jenkinsfile: 'groovy',
  '.bashrc': 'bash', '.bash_profile': 'bash', '.zshrc': 'bash', '.profile': 'bash', '.env': 'bash',
}
const LANGUAGE_BY_EXT: Record<string, string> = {
  pyi: 'python', htm: 'xml', vue: 'xml', svelte: 'xml', astro: 'xml', sass: 'scss',
  mdx: 'markdown', env: 'bash', fish: 'bash', jl: 'julia', conf: 'ini', cfg: 'ini',
}

function languageFor(name: string, lib: Hljs): string | null {
  const lower = name.toLowerCase()
  if (LANGUAGE_BY_NAME[lower]) return LANGUAGE_BY_NAME[lower]!
  if (lower.startsWith('dockerfile') || lower.startsWith('containerfile')) return 'dockerfile'
  if (lower.startsWith('.env.')) return 'bash'
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = lower.slice(dot + 1)
  const lang = LANGUAGE_BY_EXT[ext] ?? ext
  return lib.getLanguage(lang) ? lang : null
}

// ponytail: re-highlights the whole file per keystroke; past this size it
// stays plain. Incremental (per-line) highlighting if big files matter.
const MAX_HIGHLIGHT_SIZE = 256 * 1024

const highlightedHtml = computed(() => {
  const tab = activeTab.value
  const lib = hljs.value
  if (!tab || !lib || !tab.entry || tab.content.length > MAX_HIGHLIGHT_SIZE) return ''
  const lang = languageFor(tab.entry.name, lib)
  if (!lang) return ''
  // Trailing newline: a <pre> drops a final empty line that the textarea shows.
  return lib.highlight(tab.content, { language: lang, ignoreIllegals: true }).value + '\n'
})

const availableWidth = ref(0)
let measureCtx: CanvasRenderingContext2D | null = null

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx || !activeTextareaEl.value) return measureCtx
  const canvas = document.createElement('canvas')
  measureCtx = canvas.getContext('2d')
  if (measureCtx) {
    const style = window.getComputedStyle(activeTextareaEl.value)
    measureCtx.font = `${style.fontSize} ${style.fontFamily}`
  }
  return measureCtx
}

function wrappedRowCount(line: string, ctx: CanvasRenderingContext2D, maxWidth: number): number {
  if (maxWidth <= 0) return 1
  const expanded = line.replace(/\t/g, '    ')
  if (expanded === '') return 1

  let rows = 1
  let rowWidth = 0
  for (const token of expanded.split(/(\s+)/)) {
    if (token === '') continue
    const tokenWidth = ctx.measureText(token).width
    if (rowWidth > 0 && rowWidth + tokenWidth > maxWidth) {
      rows++
      rowWidth = 0
    }
    if (tokenWidth > maxWidth) {
      rows += Math.floor(tokenWidth / maxWidth)
      rowWidth = tokenWidth % maxWidth
    } else {
      rowWidth += tokenWidth
    }
  }
  return rows
}

// lineTop[i]/lineRows[i] (0-based line index) are also what positions the
// change-bar markers in the gutter (see diffMarkers below) — computed here
// alongside the line-number text since both need the same per-line wrapped
// row count in the same single pass over the content.
interface GutterLayout {
  text: string
  lineTop: number[]
  lineRows: number[]
}

const gutterLayout = computed<GutterLayout>(() => {
  const tab = activeTab.value
  if (!tab) return { text: '', lineTop: [], lineRows: [] }
  const lines = tab.content.split('\n')
  const ctx = getMeasureCtx()
  let text = ''
  const lineTop: number[] = []
  const lineRows: number[] = []
  let rowsSoFar = 0
  for (let i = 0; i < lines.length; i++) {
    const rows = ctx ? wrappedRowCount(lines[i]!, ctx, availableWidth.value) : 1
    lineTop.push(rowsSoFar)
    lineRows.push(rows)
    text += (i + 1) + '\n'.repeat(rows)
    rowsSoFar += rows
  }
  return { text, lineTop, lineRows }
})

const gutterText = computed(() => gutterLayout.value.text)

let resizeObserver: ResizeObserver | null = null

function updateAvailableWidth() {
  const textarea = activeTextareaEl.value
  if (!textarea) return
  const style = window.getComputedStyle(textarea)
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  availableWidth.value = textarea.clientWidth - padding
}

// Measured (not hardcoded from the 0.85rem/1.6 CSS values) so it stays correct
// regardless of the root font-size the line-height rem/multiplier resolves
// against — used to place diffMarkers' pixel offsets.
const lineHeightPx = ref(20)

function updateLineHeight() {
  const textarea = activeTextareaEl.value
  if (!textarea) return
  const lh = parseFloat(window.getComputedStyle(textarea).lineHeight)
  if (Number.isFinite(lh) && lh > 0) lineHeightPx.value = lh
}

function handleTextareaKeydown(e: KeyboardEvent) {
  if (e.key !== 'Tab') return
  const tab = activeTab.value
  const textarea = activeTextareaEl.value
  if (!tab || !textarea) return
  e.preventDefault()

  const value = tab.content
  const start = textarea.selectionStart
  const end = textarea.selectionEnd

  if (!e.shiftKey && start === end) {
    tab.content = value.slice(0, start) + '\t' + value.slice(end)
    nextTick(() => { textarea.selectionStart = textarea.selectionEnd = start + 1 })
    return
  }

  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const lineEndSearch = value.indexOf('\n', end)
  const lineEnd = lineEndSearch === -1 ? value.length : lineEndSearch
  const selectedLines = value.slice(lineStart, lineEnd).split('\n')

  if (!e.shiftKey) {
    const indented = selectedLines.map((line) => '\t' + line).join('\n')
    tab.content = value.slice(0, lineStart) + indented + value.slice(lineEnd)
    nextTick(() => {
      textarea.selectionStart = start + 1
      textarea.selectionEnd = end + indented.length - (lineEnd - lineStart)
    })
    return
  }

  let firstLineRemoved = 0
  let totalRemoved = 0
  const outdented = selectedLines.map((line, i) => {
    const tabMatch = line.startsWith('\t')
    const spaceMatch = !tabMatch && /^ {1,4}/.exec(line)
    const removed = tabMatch ? 1 : spaceMatch ? spaceMatch[0].length : 0
    if (i === 0) firstLineRemoved = removed
    totalRemoved += removed
    return line.slice(removed)
  }).join('\n')

  tab.content = value.slice(0, lineStart) + outdented + value.slice(lineEnd)
  nextTick(() => {
    textarea.selectionStart = Math.max(lineStart, start - firstLineRemoved)
    textarea.selectionEnd = Math.max(textarea.selectionStart, end - totalRemoved)
  })
}

watch(activeTextareaEl, (el) => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!el) return
  updateAvailableWidth()
  updateLineHeight()
  resizeObserver = new ResizeObserver(() => {
    updateAvailableWidth()
    updateLineHeight()
  })
  resizeObserver.observe(el)
})

// ── Git change markers (added = green, modified = blue) for the active tab —
// rendered as a VS Code/IntelliJ-style bar beside the line numbers rather
// than coloring the text itself (colored spans, needed for individually-
// styled text, only ever work when the editor renders as HTML; the bar only
// needs a colored rectangle per changed line, so it can be plain Vue-templated
// divs — no v-html, no risk of the scoped-CSS-vs-v-html mismatch that broke
// text coloring, and no need for the transparent-textarea-plus-overlay trick
// that was doing all that work just to make colored text visible). ─────────
const lineDiffMap = computed<LineDiffMap>(() => {
  const tab = activeTab.value
  if (!tab || !tab.gitBaselineLoaded || !tab.gitIsRepo || tab.gitUntracked || tab.gitIgnored) return new Map()
  return computeLineDiff(tab.gitOriginalContent, tab.content)
})

interface DiffMarker {
  top: number
  height: number
  kind: 'added' | 'modified'
}

const diffMarkers = computed<DiffMarker[]>(() => {
  const map = lineDiffMap.value
  if (map.size === 0) return []
  const { lineTop, lineRows } = gutterLayout.value
  const markers: DiffMarker[] = []
  for (const [lineNum, kind] of map) {
    const idx = lineNum - 1
    markers.push({
      top: (lineTop[idx] ?? 0) * lineHeightPx.value,
      height: (lineRows[idx] ?? 1) * lineHeightPx.value,
      kind,
    })
  }
  return markers
})

// ── Title / keyboard ─────────────────────────────────────────────────────
watch([activeTab, activeDirty], () => {
  const tab = activeTab.value
  if (!tab) { emit('update-title', 'Text Editor'); return }
  emit('update-title', isDirty(tab) ? `${tabLabel(tab)} •` : tabLabel(tab))
})

function handleKeydown(e: KeyboardEvent) {
  if (!props.focused) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (activeTab.value) void saveTab(activeTab.value)
  }
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown)

  await bootstrapSession()
  if (initError.value) return

  if (props.entry) {
    const tab = createTab(props.entry, false)
    tabs.value.push(tab)
    activeTabId.value = tab.id
    void loadTabContent(tab)
  } else {
    addBlankTab()
  }
  if (props.initialFolder) openedFolderPath.value = props.initialFolder
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  for (const controller of loadControllers.values()) controller.abort()
  if (savedFlashTimer) clearTimeout(savedFlashTimer)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div class="editor-window">
    <Teleport :to="actionsTarget ?? 'body'" :disabled="!actionsTarget">
      <span v-if="activeDirty" class="editor-dirty-dot" title="Unsaved changes"></span>
      <button
        class="editor-action-btn"
        @click="activeTab && saveTab(activeTab)"
        :disabled="!activeTab || !activeDirty || activeTab.saving"
        title="Save (Ctrl+S)"
      >
        <i class="bi" :class="activeTab?.saving ? 'bi-hourglass-split' : 'bi-save'"></i>
      </button>
      <button
        class="editor-action-btn"
        @click="activeTab && downloadTab(activeTab)"
        :disabled="!activeTab || activeTab.loading || !!activeTab.loadError"
        title="Download"
      >
        <i class="bi bi-download"></i>
      </button>
    </Teleport>

    <Teleport :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
      <div class="editor-toolbar">
        <button ref="filesMenuBtnRef" class="files-menu-btn" @click="toggleFilesMenu">
          <i class="bi bi-folder2"></i><span>Files</span>
        </button>
        <TabStrip
          :tabs="stripTabs"
          :active-id="activeTabId"
          new-tab-title="New file"
          @switch="switchTab"
          @close="requestCloseTab"
          @add="addBlankTab"
        />
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="filesMenuOpen" class="files-menu-backdrop" @click="closeFilesMenu">
        <div class="files-menu-dropdown" :style="filesMenuPos" @click.stop>
          <button class="files-menu-item" @click="menuNew"><i class="bi bi-file-earmark-plus"></i>New</button>
          <button class="files-menu-item" @click="menuOpenFile"><i class="bi bi-file-earmark-arrow-up"></i>Open File…</button>
          <button class="files-menu-item" @click="menuOpenFolder"><i class="bi bi-folder2-open"></i>Open Folder…</button>
          <div class="files-menu-divider"></div>
          <button class="files-menu-item" :disabled="!activeTab || !activeDirty" @click="menuSave"><i class="bi bi-save"></i>Save</button>
          <button class="files-menu-item" :disabled="!activeTab" @click="menuSaveAs"><i class="bi bi-save2"></i>Save As…</button>
          <div class="files-menu-divider"></div>
          <button class="files-menu-item" :disabled="!openedFolderPath" @click="menuCloseProject"><i class="bi bi-folder-x"></i>Close Project</button>
          <button class="files-menu-item" @click="menuExit"><i class="bi bi-box-arrow-right"></i>Exit</button>
        </div>
      </div>
    </Teleport>

    <div v-if="initError" class="editor-state">
      <i class="bi bi-exclamation-octagon display-6 mb-3"></i>
      <p class="mb-0">{{ initError }}</p>
    </div>

    <div v-else class="editor-layout">
      <template v-if="openedFolderPath && activeSession && encryptionKeys">
        <div class="editor-sidebar" :style="{ width: sidebarWidth + 'px' }">
          <EditorFileTree
            :session="activeSession"
            :realm="realm"
            :keys="encryptionKeys"
            :root-path="openedFolderPath"
            :root-name="openedFolderName"
            @open-file="onTreeOpenFile"
            @open-file-pinned="onTreeOpenFilePinned"
          />
        </div>
        <div
          class="editor-sidebar-resize"
          @pointerdown="startSidebarResize"
        ></div>
      </template>

      <div class="editor-tabs-area">
        <template v-for="tab in tabs" :key="tab.id">
          <div v-show="tab.id === activeTabId" class="editor-window-body">
            <div v-if="tab.saveError" class="editor-error-banner">
              <i class="bi bi-exclamation-triangle-fill"></i>
              <span class="editor-error-text">{{ tab.saveError }}</span>
              <button v-if="tab.saveConflict" class="editor-error-action" @click="reloadActiveTab">Reload from device</button>
              <button class="editor-error-dismiss" @click="tab.saveError = ''" title="Dismiss">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>

            <div v-if="tab.loading" class="editor-state">
              <div class="spinner-border mb-3" role="status"><span class="visually-hidden">Loading…</span></div>
              <p class="editor-progress-text">{{ formatSize(tab.loadedBytes) }} / {{ formatSize(tab.entry?.size ?? 0) }}</p>
            </div>

            <div v-else-if="tab.loadError" class="editor-state">
              <i class="bi bi-exclamation-octagon display-6 mb-3"></i>
              <p class="mb-0">{{ tab.loadError }}</p>
            </div>

            <div v-else class="editor-body">
              <div :ref="(el) => setGutterEl(tab.id, el as Element | null)" class="editor-gutter">
                <div class="editor-gutter-inner">
                  {{ tab.id === activeTabId ? gutterText : '' }}
                  <div v-if="tab.id === activeTabId" class="editor-diff-markers">
                    <div
                      v-for="(marker, idx) in diffMarkers"
                      :key="idx"
                      class="diff-marker"
                      :class="marker.kind === 'added' ? 'diff-marker-added' : 'diff-marker-modified'"
                      :style="{ top: `${marker.top}px`, height: `${marker.height}px` }"
                    ></div>
                  </div>
                </div>
              </div>
              <div class="editor-code">
              <pre
                v-if="tab.id === activeTabId && highlightedHtml"
                :ref="(el) => setHighlightEl(tab.id, el as Element | null)"
                class="editor-highlight"
                aria-hidden="true"
                v-html="highlightedHtml"
              ></pre>
              <textarea
                :ref="(el) => setTextareaEl(tab.id, el as Element | null)"
                v-model="tab.content"
                class="editor-textarea"
                :class="{ 'editor-textarea-highlighted': tab.id === activeTabId && highlightedHtml }"
                spellcheck="false"
                autocapitalize="off"
                autocomplete="off"
                wrap="soft"
                @scroll="syncGutterScroll"
                @input="syncGutterScroll"
                @mousedown="syncGutterScroll"
                @click="syncGutterScroll"
                @keyup="syncGutterScroll"
                @focus="syncGutterScroll"
                @keydown="handleTextareaKeydown"
              ></textarea>
              </div>
            </div>
          </div>
        </template>

        <div v-if="tabs.length === 0" class="editor-state">
          <i class="bi bi-file-earmark-text display-6 mb-3"></i>
          <p class="mb-0">No files open</p>
        </div>
      </div>
    </div>

    <GitFolderPicker
      v-if="picker && activeSession && encryptionKeys"
      :session="activeSession"
      :keys="encryptionKeys"
      :mode="picker.mode"
      :initial-path="picker.initialPath"
      :initial-file-name="picker.targetTab ? tabLabel(picker.targetTab) : undefined"
      @confirm="onPickerConfirm"
      @cancel="onPickerCancel"
    />

    <ConfirmDialog
      :open="!!pendingClose"
      :title="closeConfirmTitle"
      :message="closeConfirmMessage"
      confirm-label="Discard"
      @confirm="confirmPendingClose"
      @cancel="cancelPendingClose"
    />
  </div>

  <Teleport to="body">
    <Transition name="dl-toast">
      <div v-if="savedFlash" class="editor-saved-toast"><i class="bi bi-check-circle-fill"></i> Saved</div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.editor-window {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: #1e1e1e;
}

.editor-dirty-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
}

.editor-action-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid #3a3a3a;
  border-radius: 50%;
  background: linear-gradient(#565656, #454545);
  color: #fff;
  font-size: 0.6rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 1px 1px rgba(0, 0, 0, 0.3);
}
.editor-action-btn:hover:not(:disabled) { background: linear-gradient(#686868, #565656); }
.editor-action-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Toolbar: Files menu button + tab strip ── */
/* Bleeds into the titlebar's own padding, same as TerminalPanel's .tab-bar —
   without this, the titlebar ends up taller here than in the terminal since
   its 0.25rem/0.6rem padding would otherwise sit on top of the tab strip's
   own 32px height instead of being absorbed by it. */
.editor-toolbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  min-width: 0;
  margin: -0.25rem 0 -0.25rem -0.6rem;
}

.files-menu-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: #e2e2df;
  border-radius: 4px;
  padding: 0.28rem 0.5rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.files-menu-btn:hover { background: rgba(255, 255, 255, 0.1); }

.files-menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3100;
}
.files-menu-dropdown {
  position: fixed;
  display: flex;
  flex-direction: column;
  min-width: 200px;
  padding: 0.35rem;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.2);
}
.files-menu-item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  border: 0;
  background: transparent;
  border-radius: 6px;
  padding: 0.4rem 0.55rem;
  font-size: 0.82rem;
  color: #334155;
  text-align: left;
  cursor: pointer;
}
.files-menu-item:hover:not(:disabled) { background: #eef2f6; }
.files-menu-item:disabled { opacity: 0.45; cursor: not-allowed; }
.files-menu-item i { width: 16px; color: #64748b; }
.files-menu-divider {
  height: 1px;
  background: #f1f5f9;
  margin: 0.3rem 0.2rem;
}

/* ── Layout ── */
.editor-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  color-scheme: dark;
  scrollbar-color: #3a3a3a #000000;
}

.editor-sidebar {
  flex-shrink: 0;
  min-width: 0;
  overflow: hidden;
}

.editor-sidebar-resize {
  flex-shrink: 0;
  width: 5px;
  cursor: ew-resize;
  background: #3e3d32;
}
.editor-sidebar-resize:hover,
.editor-sidebar-resize:active {
  background: #4e4d40;
}

.editor-tabs-area {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow: hidden;
}

.editor-window-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  text-align: center;
  padding: 2rem;
  color: #8a8a85;
  min-height: 220px;
  background: #1e1e1e;
}
.editor-progress-text { font-size: 0.85rem; color: #94a3b8; margin: 0; }

.editor-error-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: #fef2f2;
  border-bottom: 1px solid #fecaca;
  color: #991b1b;
  font-size: 0.8rem;
  flex-shrink: 0;
}
.editor-error-text { flex: 1; min-width: 0; }
.editor-error-action {
  border: 1px solid #fca5a5;
  border-radius: 6px;
  background: #fff;
  color: #991b1b;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.25rem 0.6rem;
  cursor: pointer;
  flex-shrink: 0;
}
.editor-error-action:hover { background: #fee2e2; }
.editor-error-dismiss {
  border: 0;
  background: transparent;
  color: #991b1b;
  cursor: pointer;
  display: inline-flex;
  flex-shrink: 0;
}

.editor-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background: #1e1e1e;
}

.editor-gutter {
  flex-shrink: 0;
  overflow: hidden;
  padding: 1rem 0.75rem 1rem 1rem;
  text-align: right;
  user-select: none;
  background: #1e1e1e;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
}
.editor-gutter-inner {
  position: relative;
  /* Room for 1–99 so the gutter doesn't jump at line 10; it still grows
     with the text from 100 on. */
  min-width: 2ch;
  white-space: pre;
  font-size: 0.85rem;
  line-height: 1.6;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  color: #75715e;
}

/* VS Code/IntelliJ-style change bar, one per changed line, sitting right on
   the gutter/code boundary — rather than coloring the code text itself (see
   diffMarkers in the script: plain Vue-templated divs positioned by pixel
   offset, not v-html, so scoped CSS applies to them normally). */
.editor-diff-markers {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.diff-marker {
  position: absolute;
  right: -0.75rem;
  width: 3px;
  border-radius: 1px;
}
.diff-marker-added { background: #7ec699; }
.diff-marker-modified { background: #7fb4e0; }

.editor-code {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
/* The highlight layer must wrap exactly like the textarea above it: same
   box, font, padding and wrapping, and the same reserved scrollbar gutter
   (scrollbar-gutter on both) so the text width never differs. */
.editor-highlight,
.editor-textarea {
  margin: 0;
  padding: 1rem 1.25rem;
  font-size: 0.85rem;
  line-height: 1.6;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  tab-size: 4;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  scrollbar-gutter: stable;
}
.editor-highlight {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  color: #f8f8f2;
  background: #1e1e1e;
}
/* Bold/italic can change glyph widths in some fonts and drift the overlay. */
.editor-highlight :deep(*) {
  font-weight: inherit;
  font-style: inherit;
}
.editor-textarea-highlighted {
  position: relative;
  background: transparent !important;
  color: transparent !important;
  caret-color: #f8f8f2;
}
.editor-textarea-highlighted::selection {
  color: transparent;
  background: rgba(117, 163, 209, 0.35);
}
.editor-textarea {
  flex: 1;
  min-height: 0;
  min-width: 0;
  border: 0;
  outline: none;
  resize: none;
  background: #1e1e1e;
  color: #f8f8f2;
  overflow: auto;
  overflow-x: hidden;
}

.editor-saved-toast {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: #16a34a;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 600;
  padding: 0.55rem 0.9rem;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  z-index: 3000;
}
</style>
