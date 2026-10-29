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
import { isMac, MOD, type Command } from '@/stores/commandPalette'
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
import { splitHighlightedLines } from '@/utils/highlightLines'
import { computeLineDiff, computeReviewLines, foldReviewLines, type LineDiffMap, type ReviewLine, type ReviewRow } from '@/utils/lineDiff'
import 'highlight.js/styles/monokai-sublime.css'

const procedureFileEdit = 'io.xconn.deskconn.file.edit'
const MAX_EDIT_SIZE = 10 * 1024 * 1024

type TextEntry = { path: string; name: string; size: number }

// One open file's content and load/save/git state. Shared by every tab that
// shows it, so the same file open in both panes stays a single document:
// edits show up in both views and a save writes once.
interface DocState {
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
}

interface TabState {
  id: number
  doc: DocState
  /** Single-click-opened tabs are reusable "preview" slots (VS Code style) —
   * the next single click replaces them instead of piling up a new tab, as
   * long as they're still clean. Double-clicking or editing promotes a tab
   * out of preview (see isReusablePreview). */
  isPreview: boolean
  /** Shows a read-only diff against the last commit instead of the editor. */
  reviewMode: boolean
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
// Each pane is its own tab group (one pane normally, two when split), with
// its own strip in the titlebar. A tab belongs to exactly one pane — it owns
// a single textarea. activeTabId is the focused pane's tab, so Save/Download/
// Ctrl+S all act on it.
interface Pane {
  tabIds: number[]
  activeId: number | null
}
const panes = ref<Pane[]>([{ tabIds: [], activeId: null }])
const focusedPane = ref(0)
const activeTabId = computed(() => panes.value[focusedPane.value]?.activeId ?? null)
const isSplit = computed(() => panes.value.length === 2)
let nextTabId = 0
const loadControllers = new Map<DocState, AbortController>()

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null)

function isDirty(tab: TabState): boolean {
  return tab.doc.content !== tab.doc.originalContent
}
const activeDirty = computed(() => (activeTab.value ? isDirty(activeTab.value) : false))
const anyDirty = computed(() => tabs.value.some(isDirty))

function tabLabel(tab: TabState): string {
  return tab.doc.entry?.name ?? 'Untitled'
}

const paneStrips = computed(() => panes.value.map((pane) => pane.tabIds.flatMap((id) => {
  const t = tabs.value.find((tab) => tab.id === id)
  return t ? [{ id: t.id, label: tabLabel(t), dirty: isDirty(t), preview: t.isPreview }] : []
})))

function paneOf(id: number): number {
  return panes.value.findIndex((p) => p.tabIds.includes(id))
}
/** The pane a tab is currently showing in, or -1 if it's a background tab. */
function shownIn(id: number): number {
  return panes.value.findIndex((p) => p.activeId === id)
}

// reactive() here (not a plain object) so the reference held across the async
// gap in loadTabContent/performSave/etc. IS the reactive proxy itself — a
// plain object only becomes reactive when read back out of tabs.value, and
// mutating the pre-push reference instead bypasses Vue's change tracking
// entirely (the DOM only catches up on some later, unrelated re-render).
function createDoc(entry: TextEntry | null): DocState {
  return reactive({
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
  })
}

function createTab(doc: DocState, isPreview: boolean): TabState {
  const tab: TabState = reactive({ id: nextTabId++, doc, isPreview, reviewMode: false })
  tabViews.set(tab.id, createTabView(tab))
  return tab
}

function tabById(id: number): TabState | undefined {
  return tabs.value.find((t) => t.id === id)
}

function isShared(doc: DocState): boolean {
  return tabs.value.filter((t) => t.doc === doc).length > 1
}

/** Registers a new tab and appends it to a pane's strip (the focused one by default). */
function addTab(tab: TabState, pane = focusedPane.value) {
  tabs.value.push(tab)
  panes.value[pane]!.tabIds.push(tab.id)
}

// focusEditor=false keeps focus where it is, e.g. on the file tree so its
// arrow-key navigation keeps working after opening a file from it. Switching
// to a tab also focuses the pane it lives in.
function switchTab(id: number, focusEditor = true) {
  const pane = paneOf(id)
  if (pane === -1) return
  focusedPane.value = pane
  panes.value[pane]!.activeId = id
  nextTick(() => {
    // preventScroll alone doesn't stop the browser revealing the caret, so the
    // saved scroll position is put back after focusing.
    if (focusEditor) textareaElMap.get(id)?.focus({ preventScroll: true })
    restoreView(id)
  })
}

function focusPane(id: number) {
  const pane = shownIn(id)
  if (pane !== -1) focusedPane.value = pane
}

// Takes a tab out of its pane, showing its nearest neighbour (right first)
// in its place. A split pane left with no tabs closes; the last pane stays.
function detachTab(id: number) {
  const paneIdx = paneOf(id)
  const pane = panes.value[paneIdx]
  if (!pane) return
  const idx = pane.tabIds.indexOf(id)
  pane.tabIds.splice(idx, 1)
  if (pane.activeId === id) pane.activeId = pane.tabIds[idx] ?? pane.tabIds[idx - 1] ?? null
  if (pane.tabIds.length === 0 && isSplit.value) {
    panes.value.splice(paneIdx, 1)
    focusedPane.value = 0
  }
}

// 'row' = left | right, 'column' = top / bottom. Pane 0 is always the
// left/top one; splitPercent is its share of the split axis.
const splitDir = ref<'row' | 'column'>('row')
const SPLIT_MIN_PERCENT = 20
const splitPercent = ref(50)
const tabsAreaRef = ref<HTMLElement | null>(null)

// Pointer position along the split axis, as a percentage of the panes area.
function axisPercent(rect: DOMRect, ev: { clientX: number; clientY: number }): number {
  return splitDir.value === 'row'
    ? ((ev.clientX - rect.left) / rect.width) * 100
    : ((ev.clientY - rect.top) / rect.height) * 100
}

const toolbarPanesEl = ref<HTMLElement | null>(null)
function isInlineStrip(pane: number) {
  return pane === 1 && splitDir.value === 'column'
}

function startSplitResize(e: PointerEvent) {
  e.preventDefault()
  const rect = tabsAreaRef.value?.getBoundingClientRect()
  if (!rect) return
  trackPointer((ev) => {
    splitPercent.value = Math.min(100 - SPLIT_MIN_PERCENT, Math.max(SPLIT_MIN_PERCENT, axisPercent(rect, ev)))
  })
}

// ── Drag & drop into panes (tabs from the strip, files from the tree) ──────
// The source is tracked here rather than carried in dataTransfer: tab ids only
// mean something inside this window, and a file dragged from another editor
// window's tree may live on a different desktop.
type DragSource = { kind: 'tab'; id: number } | { kind: 'file'; entry: TextEntry }
// Unsplit: within a quarter of an edge splits toward that edge, the middle
// opens in place. Split: whichever pane is under the pointer.
type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'
const EDGE_ZONE = 0.25
const dragSource = ref<DragSource | null>(null)
const dropZone = ref<DropZone | null>(null)
// Pane whose tab strip is under the drag, if any.
const stripDropPane = ref<number | null>(null)

function startTabDrag(id: number) {
  dragSource.value = { kind: 'tab', id }
}
function startFileDrag(entry: TextEntry) {
  dragSource.value = { kind: 'file', entry: { path: entry.path, name: entry.name, size: entry.size } }
}
function endDrag() {
  dragSource.value = null
  dropZone.value = null
  stripDropPane.value = null
}

function isFirstSide(zone: DropZone) {
  return zone === 'left' || zone === 'top'
}

function onDragOver(e: DragEvent) {
  const rect = tabsAreaRef.value?.getBoundingClientRect()
  if (!dragSource.value || !rect) return
  e.preventDefault()
  if (isSplit.value) {
    const first = axisPercent(rect, e) < splitPercent.value
    dropZone.value = splitDir.value === 'row' ? (first ? 'left' : 'right') : (first ? 'top' : 'bottom')
    return
  }
  const x = (e.clientX - rect.left) / rect.width
  const y = (e.clientY - rect.top) / rect.height
  const edges = { left: x, right: 1 - x, top: y, bottom: 1 - y }
  const [nearest, dist] = Object.entries(edges).reduce((a, b) => (b[1] < a[1] ? b : a))
  dropZone.value = dist > EDGE_ZONE ? 'center' : (nearest as DropZone)
}

const dropHighlightStyle = computed(() => {
  const zone = dropZone.value
  if (!zone || zone === 'center') return { inset: '0' }
  const size = isSplit.value ? splitPercent.value : 50
  const [start, length] = isFirstSide(zone) ? [0, size] : [size, 100 - size]
  return zone === 'left' || zone === 'right'
    ? { top: '0', bottom: '0', left: `${start}%`, width: `${length}%` }
    : { left: '0', right: '0', top: `${start}%`, height: `${length}%` }
})

function onDrop(e: DragEvent) {
  e.preventDefault()
  const source = dragSource.value
  const zone = dropZone.value
  endDrag()
  if (!source || !zone) return
  // Unsplit edge zones open a new pane on that side (unless there's nothing
  // to sit beside); otherwise the drop lands in the pane under the pointer.
  const edge = !isSplit.value && zone !== 'center' && panes.value[0]!.tabIds.length > 0
  const lone = panes.value[0]!.tabIds.length === 1
  const pane = edge ? splitTo(zone) : isSplit.value && !isFirstSide(zone) ? 1 : 0
  if (source.kind === 'file') {
    openFileInTab(source.entry, true, true, pane)
    return
  }
  const tab = tabById(source.id)
  if (!tab) return
  // Splitting off a pane's only tab shows the same file in both panes
  // rather than moving it and leaving the original pane empty.
  if (edge && lone) {
    const copy = createTab(tab.doc, false)
    addTab(copy, pane)
    switchTab(copy.id)
    return
  }
  moveTabToPane(tab.id, pane)
}

function splitTo(zone: DropZone): number {
  splitDir.value = zone === 'left' || zone === 'right' ? 'row' : 'column'
  splitPercent.value = 50
  const pane = isFirstSide(zone) ? 0 : 1
  panes.value.splice(pane, 0, { tabIds: [], activeId: null })
  return pane
}

// Over a strip, the pane below lights up too — that's where the tab will show.
function onStripDragOver(e: DragEvent, pane: number) {
  if (!dragSource.value) return
  e.preventDefault()
  stripDropPane.value = pane
  if (!isSplit.value) dropZone.value = 'center'
  else if (splitDir.value === 'row') dropZone.value = pane === 0 ? 'left' : 'right'
  else dropZone.value = pane === 0 ? 'top' : 'bottom'
}

// dragleave also fires when moving onto the strip's own tabs — ignore those.
function onStripDragLeave(e: DragEvent) {
  if ((e.currentTarget as Node).contains(e.relatedTarget as Node | null)) return
  stripDropPane.value = null
  dropZone.value = null
}

function onStripDrop(pane: number) {
  const source = dragSource.value
  endDrag()
  if (source?.kind === 'file') openFileInTab(source.entry, true, true, pane)
  else if (source) moveTabToPane(source.id, pane)
}

// A pane already showing the same document just switches to that tab — the
// moved one would be a duplicate view of it, so it's dropped.
function moveTabToPane(id: number, target: number) {
  const tab = tabById(id)
  const pane = panes.value[target]
  if (!tab || !pane) return
  const twin = pane.tabIds.map(tabById).find((t) => t && t !== tab && t.doc === tab.doc)
  if (twin) {
    closeTabImmediate(id)
    switchTab(twin.id)
    return
  }
  if (!pane.tabIds.includes(id)) {
    // Held by reference: detaching can close the source pane, shifting indexes.
    detachTab(id)
    pane.tabIds.push(id)
  }
  switchTab(id)
}

function addBlankTab(pane = focusedPane.value) {
  const tab = createTab(createDoc(null), false)
  addTab(tab, pane)
  switchTab(tab.id)
}

async function loadGitBaseline(doc: DocState) {
  const session = activeSession.value
  if (!doc.entry || !session || !encryptionKeys.value) {
    doc.gitBaselineLoaded = true
    return
  }
  try {
    const result = await fetchGitOriginal(session, encryptionKeys.value, doc.entry.path)
    doc.gitOriginalContent = result.is_new ? '' : result.content
    doc.gitIsRepo = result.is_repo
    doc.gitUntracked = result.untracked
    doc.gitIgnored = result.ignored
  } catch {
    doc.gitOriginalContent = ''
    doc.gitIsRepo = false
    doc.gitUntracked = false
    doc.gitIgnored = false
  } finally {
    doc.gitBaselineLoaded = true
  }
}

async function loadTabContent(doc: DocState) {
  const session = activeSession.value
  if (!doc.entry || !session) return

  doc.loading = true
  doc.loadError = ''
  doc.loadedBytes = 0
  doc.content = ''
  doc.gitBaselineLoaded = false

  // Entries opened by path (the Open File picker) don't know their size up
  // front — refresh it via a stat-only browse before the size gate below.
  let size = doc.entry.size
  if (size <= 0 && fileBrowser.value) {
    try {
      const browse = await fileBrowser.value.browseFiles(doc.entry.path)
      size = browse.size
      doc.entry = { ...doc.entry, size }
    } catch (err) {
      doc.loadError = err instanceof Error ? err.message : 'Failed to open file'
      doc.loading = false
      return
    }
  }

  if (size > MAX_EDIT_SIZE) {
    doc.loadError = `File is too large to edit (max ${formatSize(MAX_EDIT_SIZE)}).`
    doc.loading = false
    return
  }

  const controller = new AbortController()
  loadControllers.set(doc, controller)
  const decoder = new TextDecoder('utf-8', { fatal: false })

  try {
    await streamFileCat(session, props.realm, doc.entry.path, (chunk) => {
      doc.loadedBytes += chunk.length
      doc.content += decoder.decode(chunk, { stream: true })
    }, controller.signal)
    doc.content += decoder.decode()
    doc.originalContent = doc.content
  } catch (err) {
    doc.loadError = err instanceof Error ? err.message : 'Failed to load file'
  } finally {
    doc.loading = false
  }

  void loadGitBaseline(doc)
}

/** Optionally limited to tabs in one pane. */
function findTabByPath(path: string, pane?: number): TabState | undefined {
  const ids = pane === undefined ? null : panes.value[pane]?.tabIds
  return tabs.value.find((t) => t.doc.entry?.path === path && (!ids || ids.includes(t.id)))
}

// The already-open document for a file (from a tab in either pane), or a new
// one that starts loading.
function docFor(entry: TextEntry): DocState {
  const open = findTabByPath(entry.path)
  if (open) return open.doc
  const doc = createDoc(entry)
  void loadTabContent(doc)
  return doc
}

/** pinned=false is a single click (preview, reused/replaced by the next one);
 * pinned=true is a double click or the Open File picker (always a real tab). */
// An untouched "Untitled" tab (the default blank tab a fresh window opens
// with, or one added via "New" and never typed in) isn't worth keeping
// around once a real file is opened — it gets replaced in place rather than
// left dangling next to a newly added tab.
function isReplaceableBlankTab(tab: TabState): boolean {
  return !tab.doc.entry && !isDirty(tab)
}

// Opens into a pane (the focused one by default). A file already open in the
// other pane gets a second tab here sharing the same document.
function openFileInTab(target: TextEntry, pinned: boolean, focusEditor = true, pane = focusedPane.value) {
  const existing = findTabByPath(target.path, pane)
  if (existing) {
    if (pinned) existing.isPreview = false
    switchTab(existing.id, focusEditor)
    return
  }

  const active = tabById(panes.value[pane]?.activeId ?? -1)
  const reusePreview = !pinned && active && active.isPreview && !isDirty(active)
  const reuseBlank = active && isReplaceableBlankTab(active)
  if (reusePreview || reuseBlank) {
    if (!isShared(active.doc)) loadControllers.get(active.doc)?.abort()
    active.doc = docFor(target)
    active.isPreview = !pinned
    switchTab(active.id, focusEditor)
    return
  }

  const tab = createTab(docFor(target), !pinned)
  addTab(tab, pane)
  switchTab(tab.id, focusEditor)
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
  const n = new Set(tabs.value.filter(isDirty).map((t) => t.doc)).size
  return `${n} file${n === 1 ? '' : 's'} have unsaved changes. Close this window anyway?`
}

function closeTabImmediate(id: number) {
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx === -1) return
  const { doc } = tabs.value[idx]!
  if (!isShared(doc)) {
    loadControllers.get(doc)?.abort()
    loadControllers.delete(doc)
  }
  tabs.value.splice(idx, 1)
  tabViews.delete(id)
  viewStates.delete(id)
  detachTab(id)
}

function requestCloseTab(id: number, e?: Event) {
  e?.stopPropagation()
  const tab = tabs.value.find((t) => t.id === id)
  if (!tab) return
  // Another tab still showing the same document keeps the changes alive.
  if (isDirty(tab) && !isShared(tab.doc)) {
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
const commands = computed<Command[]>(() => {
  const tab = activeTab.value
  const editable = !!tab && !tab.reviewMode
  return [
    { id: 'new', label: 'New file', icon: 'bi-file-earmark-plus', run: menuNew },
    { id: 'open-file', label: 'Open file…', icon: 'bi-file-earmark', run: menuOpenFile },
    { id: 'open-folder', label: 'Open folder…', icon: 'bi-folder2-open', keywords: 'project', run: menuOpenFolder },
    ...(tab ? [
      { id: 'save', label: 'Save', icon: 'bi-save', keys: [MOD, 'S'], run: menuSave },
      { id: 'save-as', label: 'Save as…', icon: 'bi-save2', run: menuSaveAs },
      { id: 'download', label: 'Download file', icon: 'bi-download', run: () => downloadTab(tab) },
    ] : []),
    ...(editable ? [
      { id: 'find', label: 'Find', icon: 'bi-search', keys: [MOD, 'F'], keywords: 'search', run: () => openFind(false) },
      { id: 'replace', label: 'Find and replace', icon: 'bi-arrow-left-right', keys: isMac ? ['⌘', '⌥', 'F'] : ['Ctrl', 'H'], run: () => openFind(true) },
    ] : []),
    ...(openedFolderPath.value ? [{ id: 'close-project', label: 'Close folder', icon: 'bi-folder-x', keywords: 'project', run: menuCloseProject }] : []),
  ].map((c) => ({ group: '', ...c }))
})

defineExpose({ requestClose, commands })

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

function trackPointer(onMove: (ev: PointerEvent) => void) {
  function onUp() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function startSidebarResize(e: PointerEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = sidebarWidth.value
  trackPointer((ev) => {
    const next = startWidth + (ev.clientX - startX)
    sidebarWidth.value = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next))
  })
}

type PickerState = { mode: 'open-file' | 'open-folder' | 'save-as'; targetTab?: TabState; initialPath?: string }
const picker = ref<PickerState | null>(null)

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx > 0 ? path.slice(0, idx) : '/'
}

function openSaveAsPicker(tab: TabState) {
  const initialPath = tab.doc.entry ? dirOf(tab.doc.entry.path) : openedFolderPath.value || undefined
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
    void createNewFile(p.targetTab.doc, path)
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
  if (!isDirty(tab) || tab.doc.saving) return
  if (!tab.doc.entry) {
    openSaveAsPicker(tab)
    return
  }
  await performSave(tab.doc)
}

async function performSave(doc: DocState) {
  const session = activeSession.value
  if (!session || !doc.entry) return
  doc.saving = true
  doc.saveError = ''
  doc.saveConflict = false

  try {
    const patch = buildEditPatch(doc.originalContent, doc.content)
    const keys = await sessionEncryptionStore.getOrExchange(session, props.realm)
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ path: doc.entry.path, patch }))
    const encrypted = encryptPayload(payloadBytes, keys.encryptKey)

    const result = await session.call(procedureFileEdit, [encrypted])
    const encryptedResult = result.args?.[0]
    if (encryptedResult) decryptPayload(encryptedResult as Uint8Array, keys.decryptKey)

    doc.originalContent = doc.content
    notifyFileChanged(props.realm, doc.entry.path)
    flashSaved()
  } catch (err) {
    doc.saveConflict = isEditConflictError(err)
    if (isDesktopOfflineError(err)) sessionCacheStore.reportUnreachable(props.realm)
    doc.saveError = formatDesktopError(err, 'Failed to save file')
  } finally {
    doc.saving = false
  }
}

// file.edit only patches a file that already exists — a brand-new destination
// (first save of an untitled tab, or "Save As" to a new path) goes through
// file.upload instead, which creates-or-overwrites unconditionally.
async function createNewFile(doc: DocState, fullPath: string) {
  const session = activeSession.value
  if (!session) return
  const lastSlash = fullPath.lastIndexOf('/')
  const dir = lastSlash > 0 ? fullPath.slice(0, lastSlash) : '/'
  const name = fullPath.slice(lastSlash + 1)

  doc.saving = true
  doc.saveError = ''
  doc.saveConflict = false
  try {
    const blob = new Blob([doc.content], { type: 'text/plain' })
    await uploadFileToPath(session, props.realm, dir, name, blob)
    doc.entry = { path: fullPath, name, size: blob.size }
    doc.originalContent = doc.content
    void loadGitBaseline(doc)
    flashSaved()
  } catch (err) {
    doc.saveError = formatDesktopError(err, 'Failed to save file')
  } finally {
    doc.saving = false
  }
}

function downloadTab(tab: TabState) {
  downloadBlob(new Blob([tab.doc.content], { type: 'text/plain' }), tabLabel(tab) === 'Untitled' ? 'untitled.txt' : tabLabel(tab))
}

async function reloadTab(tab: TabState) {
  if (!tab.doc.entry) return
  if (isDirty(tab) && !window.confirm('Reload will discard your unsaved changes. Continue?')) return
  loadControllers.get(tab.doc)?.abort()
  tab.doc.saveError = ''
  tab.doc.saveConflict = false
  await loadTabContent(tab.doc)
}

// ── Gutter / wrap — computed per tab (see createTabView) since a split shows
// two tabs at once; hidden tabs never read theirs, so they cost nothing. ─────
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
  const prev = textareaElMap.get(id)
  if (el === prev) return
  if (prev) resizeObserver.unobserve(prev)
  if (el) {
    textareaElMap.set(id, el as HTMLTextAreaElement)
    resizeObserver.observe(el)
    // A fresh textarea's caret sits at the end of the value it was given;
    // start at the top instead (or where this tab was, if it's remounting).
    if (!viewStates.has(id)) viewStates.set(id, { top: 0, start: 0, end: 0 })
    restoreView(id)
  } else {
    textareaElMap.delete(id)
  }
}
function setGutterEl(id: number, el: Element | null) {
  if (el) gutterElMap.set(id, el as HTMLElement)
  else gutterElMap.delete(id)
}

const activeTextareaEl = computed(() => (activeTabId.value !== null ? textareaElMap.get(activeTabId.value) ?? null : null))

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
function syncGutterScroll(id: number) {
  const textarea = textareaElMap.get(id)
  const top = textarea?.scrollTop ?? 0
  // Hidden (v-show) textareas report 0 for everything — don't record that.
  if (textarea?.clientHeight) {
    viewStates.set(id, { top, start: textarea.selectionStart, end: textarea.selectionEnd })
  }
  const gutter = gutterElMap.get(id)
  if (gutter) gutter.scrollTop = top
  const highlight = highlightElMap.get(id)
  if (highlight) highlight.scrollTop = top
  if (findMarksEl && id === activeTabId.value) findMarksEl.scrollTop = top
}

// ── Per-tab scroll position and caret ──────────────────────────────────────
// The browser forgets or moves both behind the user's back: a v-show-hidden
// textarea can come back scrolled to the top, wheel-scrolling never moves the
// caret, focusing scrolls to wherever the caret is, and any programmatic
// value change (the other pane editing the same document) throws the caret
// to the end. So each tab's last real position is recorded (syncGutterScroll
// runs on every scroll/caret-moving event) and put back when needed.
interface ViewState { top: number; start: number; end: number }
const viewStates = new Map<number, ViewState>()

function restoreView(id: number) {
  const textarea = textareaElMap.get(id)
  const view = viewStates.get(id)
  if (!textarea?.clientHeight || !view) return
  textarea.setSelectionRange(view.start, view.end)
  textarea.scrollTop = view.top
  syncGutterScroll(id)
}

// Another tab showing the same document just changed it — keep every view
// the user isn't typing in where it was.
watch(() => tabs.value.map((t) => t.doc.content), () => {
  for (const [id, textarea] of textareaElMap) {
    if (textarea !== document.activeElement) restoreView(id)
  }
}, { flush: 'post' })

// ── Syntax highlighting: a <pre> of highlight.js markup sits under a
// transparent-text textarea, wrapped and scrolled identically, so the caret,
// selection and editing stay the textarea's own.
type Hljs = typeof import('highlight.js').default
const hljs = shallowRef<Hljs | null>(null)
// Loaded on demand — the full build (~190 languages) is big.
void import('highlight.js').then((m) => { hljs.value = m.default })

const highlightElMap = new Map<number, HTMLElement>()
// A freshly mounted layer (tab shown, highlighter just loaded) starts at the
// top, so sync it to the textarea's current scroll right away.
function setHighlightEl(id: number, el: Element | null) {
  if (!el) {
    highlightElMap.delete(id)
  } else if (highlightElMap.get(id) !== el) {
    highlightElMap.set(id, el as HTMLElement)
    syncGutterScroll(id)
  }
}

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

// Text width (textarea minus padding) per tab, kept current by resizeObserver.
const availableWidthMap = reactive(new Map<number, number>())
// Font and line height are the same for every textarea (shared CSS), so the
// first one measured sets them for all.
let measureCtx: CanvasRenderingContext2D | null = null

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

// Measured (not hardcoded from the 0.85rem/1.6 CSS values) so it stays correct
// regardless of the root font-size the line-height rem/multiplier resolves
// against — used to place diffMarkers' pixel offsets.
const lineHeightPx = ref(20)

// Fires on mount and whenever a textarea is resized or shown again (v-show
// takes it from 0 to its real size). A hidden one (0 wide) keeps its last width.
const resizeObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const textarea = target as HTMLTextAreaElement
    if (!textarea.clientWidth) continue
    const style = window.getComputedStyle(textarea)
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d')
      if (measureCtx) measureCtx.font = `${style.fontSize} ${style.fontFamily}`
    }
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    availableWidthMap.set(Number(textarea.dataset.tabId), textarea.clientWidth - padding)
    const lh = parseFloat(style.lineHeight)
    if (Number.isFinite(lh) && lh > 0) lineHeightPx.value = lh
  }
})

// Programmatic edits go through execCommand so they land on the browser's own
// undo stack (Ctrl+Z / Ctrl+Shift+Z); assigning the value directly wipes it.
// It needs the textarea focused, so focus is borrowed and handed back.
function editText(textarea: HTMLTextAreaElement, from: number, to: number, text: string) {
  const back = document.activeElement as HTMLElement | null
  textarea.focus({ preventScroll: true })
  textarea.setSelectionRange(from, to)
  if (!document.execCommand(text ? 'insertText' : 'delete', false, text)) {
    // Not undoable, but still applied.
    textarea.setRangeText(text, from, to, 'end')
    textarea.dispatchEvent(new Event('input'))
  }
  if (back && back !== textarea) back.focus({ preventScroll: true })
}

function handleTextareaKeydown(e: KeyboardEvent) {
  if (e.key !== 'Tab') return
  const tab = activeTab.value
  const textarea = activeTextareaEl.value
  if (!tab || !textarea) return
  e.preventDefault()

  const value = tab.doc.content
  const start = textarea.selectionStart
  const end = textarea.selectionEnd

  if (!e.shiftKey && start === end) {
    editText(textarea, start, end, '\t')
    return
  }

  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const lineEndSearch = value.indexOf('\n', end)
  const lineEnd = lineEndSearch === -1 ? value.length : lineEndSearch
  const selectedLines = value.slice(lineStart, lineEnd).split('\n')

  if (!e.shiftKey) {
    const indented = selectedLines.map((line) => '\t' + line).join('\n')
    editText(textarea, lineStart, lineEnd, indented)
    textarea.setSelectionRange(start + 1, end + indented.length - (lineEnd - lineStart))
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

  if (!totalRemoved) return
  editText(textarea, lineStart, lineEnd, outdented)
  const newStart = Math.max(lineStart, start - firstLineRemoved)
  textarea.setSelectionRange(newStart, Math.max(newStart, end - totalRemoved))
}

// ── Git change markers (added = green, modified = blue) for each shown tab —
// rendered as a VS Code/IntelliJ-style bar beside the line numbers rather
// than coloring the text itself (colored spans, needed for individually-
// styled text, only ever work when the editor renders as HTML; the bar only
// needs a colored rectangle per changed line, so it can be plain Vue-templated
// divs — no v-html, no risk of the scoped-CSS-vs-v-html mismatch that broke
// text coloring, and no need for the transparent-textarea-plus-overlay trick
// that was doing all that work just to make colored text visible). ─────────
interface DiffMarker {
  top: number
  height: number
  kind: 'added' | 'modified'
}

// Per-tab derived view state. Computeds are lazy, so only the tabs a pane
// actually renders ever highlight/lay out their content.
function createTabView(tab: TabState) {
  const highlightedHtml = computed(() => {
    const lib = hljs.value
    if (!lib || !tab.doc.entry || tab.doc.content.length > MAX_HIGHLIGHT_SIZE) return ''
    const lang = languageFor(tab.doc.entry.name, lib)
    if (!lang) return ''
    // Trailing newline: a <pre> drops a final empty line that the textarea shows.
    return lib.highlight(tab.doc.content, { language: lang, ignoreIllegals: true }).value + '\n'
  })

  const gutterLayout = computed<GutterLayout>(() => {
    const lines = tab.doc.content.split('\n')
    const width = availableWidthMap.get(tab.id) ?? 0
    let text = ''
    const lineTop: number[] = []
    const lineRows: number[] = []
    let rowsSoFar = 0
    for (let i = 0; i < lines.length; i++) {
      const rows = measureCtx ? wrappedRowCount(lines[i]!, measureCtx, width) : 1
      lineTop.push(rowsSoFar)
      lineRows.push(rows)
      text += (i + 1) + '\n'.repeat(rows)
      rowsSoFar += rows
    }
    return { text, lineTop, lineRows }
  })

  const lineDiffMap = computed<LineDiffMap>(() => {
    if (!tab.doc.gitBaselineLoaded || !tab.doc.gitIsRepo || tab.doc.gitUntracked || tab.doc.gitIgnored) return new Map()
    return computeLineDiff(tab.doc.gitOriginalContent, tab.doc.content)
  })

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

  // Every file is viewable in review: one with no git baseline (not in a
  // repo, ignored, still loading) is diffed against itself, i.e. shown as-is.
  // Untracked files diff against nothing, so every line reads as added.
  const hasBaseline = computed(() => tab.doc.gitBaselineLoaded && tab.doc.gitIsRepo && !tab.doc.gitIgnored)
  const reviewBase = computed(() => {
    const d = tab.doc
    return !hasBaseline.value ? d.content : d.gitUntracked ? '' : d.gitOriginalContent
  })
  const reviewLines = computed(() => computeReviewLines(reviewBase.value, tab.doc.content))
  // Per-line syntax-highlighted HTML for both sides (null = show plain text).
  // The current side reuses the editor's own highlight of the document.
  const reviewHighlight = computed(() => {
    const lib = hljs.value
    const current = highlightedHtml.value
    if (!lib || !current || !tab.doc.entry || reviewBase.value.length > MAX_HIGHLIGHT_SIZE) return null
    const newLines = splitHighlightedLines(current)
    if (reviewBase.value === tab.doc.content) return { oldLines: newLines, newLines }
    const lang = languageFor(tab.doc.entry.name, lib)!
    const old = lib.highlight(reviewBase.value, { language: lang, ignoreIllegals: true }).value
    return { oldLines: splitHighlightedLines(old), newLines }
  })
  const reviewWholeFile = ref(true)
  const reviewExpanded = reactive(new Set<number>())
  const reviewRows = computed(() => {
    const lines = reviewLines.value ?? []
    return reviewWholeFile.value ? lines : foldReviewLines(lines, REVIEW_CONTEXT, reviewExpanded)
  })
  const reviewStats = computed(() => {
    const lines = reviewLines.value ?? []
    return {
      added: lines.filter((l) => l.kind === 'added').length,
      removed: lines.filter((l) => l.kind === 'removed').length,
    }
  })
  // Shown in the review bar in place of the change counts/navigation.
  const reviewNote = computed(() => {
    if (!tab.doc.gitBaselineLoaded) return 'Loading the last committed version…'
    if (!hasBaseline.value) return 'Not tracked by git'
    if (reviewStats.value.added + reviewStats.value.removed === 0) return 'No changes since the last commit'
    return ''
  })

  return { highlightedHtml, gutterLayout, diffMarkers, reviewLines, reviewHighlight, reviewRows, reviewWholeFile, reviewExpanded, reviewStats, reviewNote }
}

// ── Review mode: read-only diff of the tab's document against git HEAD ─────
// Unchanged lines more than this far from a change fold into a clickable row.
const REVIEW_CONTEXT = 3
// Room left above a change jumped to, so its leading context stays in view.
const REVIEW_JUMP_MARGIN = 48

// Leaving review remounts the textarea, which restores its scroll/caret.
function toggleReview(tab: TabState) {
  tab.reviewMode = !tab.reviewMode
  viewOf(tab).reviewExpanded.clear()
  if (!tab.reviewMode) switchTab(tab.id)
}

function reviewLineHtml(tab: TabState, row: ReviewLine): string | null {
  const hl = viewOf(tab).reviewHighlight.value
  if (!hl) return null
  return (row.kind === 'removed' ? hl.oldLines[row.oldNo! - 1] : hl.newLines[row.newNo! - 1]) ?? ''
}

function isHunkStart(rows: ReviewRow[], i: number): boolean {
  const prev = rows[i - 1]
  return rows[i]!.kind !== 'context' && (!prev || prev.kind === 'context' || prev.kind === 'fold')
}

const reviewElMap = new Map<number, HTMLElement>()
function setReviewEl(id: number, el: Element | null) {
  if (el) reviewElMap.set(id, el as HTMLElement)
  else reviewElMap.delete(id)
}

function jumpToChange(id: number, dir: 1 | -1) {
  const body = reviewElMap.get(id)
  if (!body) return
  const tops = [...body.querySelectorAll<HTMLElement>('.review-hunk-start')]
    .map((el) => Math.max(0, el.offsetTop - REVIEW_JUMP_MARGIN))
  const current = body.scrollTop
  const target = dir === 1 ? tops.find((t) => t > current + 1) : tops.reverse().find((t) => t < current - 1)
  if (target !== undefined) body.scrollTop = target
}

const tabViews = new Map<number, ReturnType<typeof createTabView>>()
function viewOf(tab: TabState) {
  return tabViews.get(tab.id)!
}

// ── Find / replace (Ctrl+F, Ctrl+H) ──────────────────────────────────────
// One bar, acting on the focused pane's tab. Matches are painted by a
// transparent-text overlay over the textarea (same box and wrapping as the
// highlight layer), since an unfocused textarea doesn't show its selection.
const FIND_MAX_MATCHES = 10000
const find = reactive({ open: false, replace: false, query: '', replacement: '', matchCase: false, index: 0 })
const findInputEl = ref<HTMLInputElement | null>(null)
let findMarksEl: HTMLElement | null = null

const findRegex = computed(() =>
  new RegExp(find.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), find.matchCase ? 'g' : 'gi'))

const findMatches = computed(() => {
  const tab = activeTab.value
  if (!find.open || !find.query || !tab || tab.reviewMode) return []
  const matches: { start: number; end: number }[] = []
  for (const m of tab.doc.content.matchAll(findRegex.value)) {
    matches.push({ start: m.index, end: m.index + m[0].length })
    // ponytail: highlighting/stepping stops at the cap; Replace all isn't capped.
    if (matches.length === FIND_MAX_MATCHES) break
  }
  return matches
})
const findCurrent = computed(() => Math.min(find.index, findMatches.value.length - 1))

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const findMarksHtml = computed(() => {
  const text = activeTab.value?.doc.content ?? ''
  let html = ''
  let pos = 0
  findMatches.value.forEach(({ start, end }, i) => {
    html += escapeHtml(text.slice(pos, start))
      + `<mark${i === findCurrent.value ? ' class="find-current"' : ''}>${escapeHtml(text.slice(start, end))}</mark>`
    pos = end
  })
  return pos ? html + escapeHtml(text.slice(pos)) + '\n' : ''
})

function setFindMarksEl(id: number, el: Element | null) {
  if (findMarksEl === el) return
  findMarksEl = el as HTMLElement | null
  if (el) syncGutterScroll(id)
}

// Selects the current match and scrolls it into view — after the DOM update,
// so a just-replaced value is in the textarea (and the content watch above,
// which restores unfocused views, has already run).
function revealMatch() {
  void nextTick(() => {
    const id = activeTabId.value
    const textarea = activeTextareaEl.value
    const m = findMatches.value[findCurrent.value]
    if (id === null || !textarea || !m) return
    textarea.setSelectionRange(m.start, m.end)
    const mark = findMarksEl?.querySelector<HTMLElement>('.find-current')
    if (mark && (mark.offsetTop < textarea.scrollTop
      || mark.offsetTop + mark.offsetHeight > textarea.scrollTop + textarea.clientHeight)) {
      textarea.scrollTop = mark.offsetTop - textarea.clientHeight / 3
    }
    syncGutterScroll(id)
  })
}

// Typing in the bar jumps to the first match at or after the caret.
watch(() => [find.query, find.matchCase], () => {
  const caret = activeTabId.value !== null ? viewStates.get(activeTabId.value)?.start ?? 0 : 0
  find.index = Math.max(0, findMatches.value.findIndex((m) => m.start >= caret))
  revealMatch()
})

function openFind(replace: boolean): boolean {
  const textarea = activeTextareaEl.value
  if (!textarea || activeTab.value?.reviewMode) return false
  const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)
  if (selected && !selected.includes('\n')) find.query = selected
  find.open = true
  find.replace = replace
  void nextTick(() => findInputEl.value?.select())
  return true
}

function closeFind() {
  find.open = false
  if (activeTabId.value !== null) switchTab(activeTabId.value)
}

function stepMatch(dir: 1 | -1) {
  const n = findMatches.value.length
  if (!n) return
  find.index = (findCurrent.value + dir + n) % n
  revealMatch()
}

function replaceCurrent() {
  const textarea = activeTextareaEl.value
  const m = findMatches.value[findCurrent.value]
  if (!textarea || !m) return
  editText(textarea, m.start, m.end, find.replacement)
  // Skip past the inserted text, in case it contains the query itself.
  const after = m.start + find.replacement.length
  find.index = Math.max(0, findMatches.value.findIndex((x) => x.start >= after))
  revealMatch()
}

function replaceAll() {
  const tab = activeTab.value
  const textarea = activeTextareaEl.value
  if (!tab || !textarea || !findMatches.value.length) return
  // One edit for the whole file, so a single Ctrl+Z undoes it.
  editText(textarea, 0, tab.doc.content.length, tab.doc.content.replace(findRegex.value, () => find.replacement))
}

// ── Title / keyboard ─────────────────────────────────────────────────────
watch([activeTab, activeDirty], () => {
  const tab = activeTab.value
  if (!tab) { emit('update-title', 'Text Editor'); return }
  emit('update-title', isDirty(tab) ? `${tabLabel(tab)} •` : tabLabel(tab))
})

function handleKeydown(e: KeyboardEvent) {
  if (!props.focused) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (activeTab.value) void saveTab(activeTab.value)
  } else if (mod && e.code === 'KeyF') {
    // Cmd+Alt+F on macOS, where Cmd+H hides the app.
    if (openFind(e.altKey)) e.preventDefault()
  } else if (e.ctrlKey && e.code === 'KeyH') {
    if (openFind(true)) e.preventDefault()
  } else if (e.key === 'Escape' && find.open) {
    closeFind()
  }
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown)
  // Clears a drag that ended anywhere but our drop overlay (Esc, outside).
  document.addEventListener('dragend', endDrag)

  await bootstrapSession()
  if (initError.value) return

  if (props.entry) {
    const tab = createTab(docFor(props.entry), false)
    addTab(tab)
    panes.value[0]!.activeId = tab.id
  } else {
    addBlankTab()
  }
  if (props.initialFolder) openedFolderPath.value = props.initialFolder
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('dragend', endDrag)
  for (const controller of loadControllers.values()) controller.abort()
  if (savedFlashTimer) clearTimeout(savedFlashTimer)
  resizeObserver.disconnect()
})
</script>

<template>
  <div class="editor-window">
    <Teleport :to="actionsTarget ?? 'body'" :disabled="!actionsTarget">
      <span v-if="activeDirty" class="editor-dirty-dot" title="Unsaved changes"></span>
      <button
        class="editor-action-btn"
        @click="activeTab && saveTab(activeTab)"
        :disabled="!activeTab || !activeDirty || activeTab.doc.saving"
        title="Save (Ctrl+S)"
      >
        <i class="bi" :class="activeTab?.doc.saving ? 'bi-hourglass-split' : 'bi-save'"></i>
      </button>
      <button
        class="editor-action-btn"
        @click="activeTab && downloadTab(activeTab)"
        :disabled="!activeTab || activeTab.doc.loading || !!activeTab.doc.loadError"
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
        <div ref="toolbarPanesEl" class="editor-toolbar-panes"></div>
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
            @drag-file="startFileDrag"
            :review-active="!!activeTab?.reviewMode"
            :review-disabled="!activeTab?.doc.entry"
            @toggle-review="activeTab && toggleReview(activeTab)"
          />
        </div>
        <div
          class="editor-sidebar-resize"
          @pointerdown="startSidebarResize"
        ></div>
      </template>

      <div
        ref="tabsAreaRef"
        class="editor-tabs-area"
        :class="{ 'editor-split': isSplit, 'editor-split-column': isSplit && splitDir === 'column' }"
      >
        <!-- Panes are placed with flex `order` (first 0, divider 1, the
             bottom pane's strip 2, second 3)
             rather than by moving tab bodies between containers, so a tab's
             textarea is never remounted when it changes pane. -->
        <div v-if="isSplit" class="editor-split-resize" @pointerdown="startSplitResize"></div>
        <!-- Each pane's strip sits right above its view: in the titlebar
             (teleported), except the bottom pane of a top/bottom split, whose
             strip stays here between the divider and that pane. In a
             left/right split the titlebar strips roughly track pane widths.
             Dropping on a strip moves the tab/file into that pane. -->
        <Teleport
          v-for="(strip, i) in paneStrips"
          :key="i"
          :to="toolbarPanesEl"
          :disabled="!toolbarPanesEl || isInlineStrip(i)"
        >
          <div
            class="editor-toolbar-pane"
            :class="{
              'editor-toolbar-pane-unfocused': isSplit && i !== focusedPane,
              'editor-toolbar-pane-drop': stripDropPane === i,
              'editor-pane-strip': isInlineStrip(i),
            }"
            :style="isInlineStrip(i)
              ? undefined
              : { flex: `${isSplit && splitDir === 'row' ? (i === 0 ? splitPercent : 100 - splitPercent) : 1} 1 0` }"
            @dragenter="onStripDragOver($event, i)"
            @dragover="onStripDragOver($event, i)"
            @dragleave="onStripDragLeave"
            @drop.prevent="onStripDrop(i)"
          >
            <TabStrip
              :tabs="strip"
              :active-id="panes[i]?.activeId ?? null"
              new-tab-title="New file"
              draggable-tabs
              @drag-start="startTabDrag"
              @switch="switchTab"
              @close="requestCloseTab"
              @add="addBlankTab(i)"
            />
          </div>
        </Teleport>
        <!-- Covers the panes for the whole drag, so the textareas underneath
             neither take the drop as text nor make dragleave flicker. -->
        <div
          v-if="dragSource"
          class="editor-drop-overlay"
          @dragenter="onDragOver"
          @dragover="onDragOver"
          @dragleave="dropZone = null"
          @drop="onDrop"
        >
          <div v-if="dropZone" class="editor-drop-highlight" :style="dropHighlightStyle"></div>
        </div>
        <template v-for="tab in tabs" :key="tab.id">
          <div
            v-show="shownIn(tab.id) !== -1"
            class="editor-window-body"
            :style="isSplit && shownIn(tab.id) !== -1
              ? { order: shownIn(tab.id) * 3, flex: shownIn(tab.id) === 0 ? `0 0 ${splitPercent}%` : '1' }
              : undefined"
            @mousedown="focusPane(tab.id)"
          >
            <div v-if="tab.doc.saveError" class="editor-error-banner">
              <i class="bi bi-exclamation-triangle-fill"></i>
              <span class="editor-error-text">{{ tab.doc.saveError }}</span>
              <button v-if="tab.doc.saveConflict" class="editor-error-action" @click="reloadTab(tab)">Reload from device</button>
              <button class="editor-error-dismiss" @click="tab.doc.saveError = ''" title="Dismiss">
                <i class="bi bi-x-lg"></i>
              </button>
            </div>

            <div v-if="tab.doc.loading" class="editor-state">
              <div class="spinner-border mb-3" role="status"><span class="visually-hidden">Loading…</span></div>
              <p class="editor-progress-text">{{ formatSize(tab.doc.loadedBytes) }} / {{ formatSize(tab.doc.entry?.size ?? 0) }}</p>
            </div>

            <div v-else-if="tab.doc.loadError" class="editor-state">
              <i class="bi bi-exclamation-octagon display-6 mb-3"></i>
              <p class="mb-0">{{ tab.doc.loadError }}</p>
            </div>

            <div v-else-if="tab.reviewMode" class="review-view">
              <div class="review-bar">
                <i class="bi bi-file-diff"></i>
                <span class="review-title">{{ viewOf(tab).reviewNote.value || 'Changes since last commit' }}</span>
                <template v-if="!viewOf(tab).reviewNote.value">
                  <div class="review-toggle" role="group" aria-label="Review view">
                    <button
                      :class="{ 'review-toggle-on': viewOf(tab).reviewWholeFile.value }"
                      @click="viewOf(tab).reviewWholeFile.value = true"
                    >Whole file</button>
                    <button
                      :class="{ 'review-toggle-on': !viewOf(tab).reviewWholeFile.value }"
                      @click="viewOf(tab).reviewWholeFile.value = false"
                    >Changes only</button>
                  </div>
                  <span class="review-stat-added">+{{ viewOf(tab).reviewStats.value.added }}</span>
                  <span class="review-stat-removed">−{{ viewOf(tab).reviewStats.value.removed }}</span>
                  <button class="review-btn" title="Previous change" @click="jumpToChange(tab.id, -1)">
                    <i class="bi bi-chevron-up"></i>
                  </button>
                  <button class="review-btn" title="Next change" @click="jumpToChange(tab.id, 1)">
                    <i class="bi bi-chevron-down"></i>
                  </button>
                </template>
                <button class="review-btn review-btn-text" title="Back to editing" @click="toggleReview(tab)">
                  <i class="bi bi-pencil"></i>Edit
                </button>
              </div>
              <div v-if="!viewOf(tab).reviewLines.value" class="editor-state">
                <i class="bi bi-file-diff display-6 mb-3"></i>
                <p class="mb-0">This file is too large to diff.</p>
              </div>
              <div v-else :ref="(el) => setReviewEl(tab.id, el as Element | null)" class="review-body">
                <template v-for="(row, i) in viewOf(tab).reviewRows.value" :key="i">
                  <button v-if="row.kind === 'fold'" class="review-fold" @click="viewOf(tab).reviewExpanded.add(row.from)">
                    <i class="bi bi-arrows-expand"></i>{{ row.count }} unchanged lines
                  </button>
                  <div
                    v-else
                    class="review-line"
                    :class="[`review-line-${row.kind}`, { 'review-hunk-start': isHunkStart(viewOf(tab).reviewRows.value, i) }]"
                  >
                    <span class="review-no">{{ row.oldNo ?? '' }}</span>
                    <span class="review-no">{{ row.newNo ?? '' }}</span>
                    <span class="review-sign">{{ row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : '' }}</span>
                    <span v-if="viewOf(tab).reviewHighlight.value" class="review-text" v-html="reviewLineHtml(tab, row)"></span>
                    <span v-else class="review-text">{{ row.text }}</span>
                  </div>
                </template>
              </div>
            </div>

            <div v-else class="editor-body">
              <div :ref="(el) => setGutterEl(tab.id, el as Element | null)" class="editor-gutter">
                <div class="editor-gutter-inner">
                  {{ shownIn(tab.id) !== -1 ? viewOf(tab).gutterLayout.value.text : '' }}
                  <div v-if="shownIn(tab.id) !== -1" class="editor-diff-markers">
                    <div
                      v-for="(marker, idx) in viewOf(tab).diffMarkers.value"
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
                v-if="shownIn(tab.id) !== -1 && viewOf(tab).highlightedHtml.value"
                :ref="(el) => setHighlightEl(tab.id, el as Element | null)"
                class="editor-highlight"
                aria-hidden="true"
                v-html="viewOf(tab).highlightedHtml.value"
              ></pre>
              <textarea
                :ref="(el) => setTextareaEl(tab.id, el as Element | null)"
                v-model="tab.doc.content"
                :data-tab-id="tab.id"
                class="editor-textarea"
                :class="{ 'editor-textarea-highlighted': shownIn(tab.id) !== -1 && viewOf(tab).highlightedHtml.value }"
                spellcheck="false"
                autocapitalize="off"
                autocomplete="off"
                wrap="soft"
                @scroll="syncGutterScroll(tab.id)"
                @input="syncGutterScroll(tab.id)"
                @mousedown="syncGutterScroll(tab.id)"
                @click="syncGutterScroll(tab.id)"
                @keyup="syncGutterScroll(tab.id)"
                @focus="syncGutterScroll(tab.id); focusPane(tab.id)"
                @keydown="handleTextareaKeydown"
              ></textarea>
              <template v-if="find.open && tab.id === activeTabId">
                <pre
                  v-if="findMarksHtml"
                  :ref="(el) => setFindMarksEl(tab.id, el as Element | null)"
                  class="editor-find-marks"
                  aria-hidden="true"
                  v-html="findMarksHtml"
                ></pre>
                <div class="find-bar">
                  <div class="find-row">
                    <button class="find-btn" :title="find.replace ? 'Hide replace' : 'Replace'" @click="find.replace = !find.replace">
                      <i class="bi" :class="find.replace ? 'bi-chevron-down' : 'bi-chevron-right'"></i>
                    </button>
                    <input
                      :ref="(el) => { findInputEl = el as HTMLInputElement | null }"
                      v-model="find.query"
                      class="find-input"
                      placeholder="Find"
                      spellcheck="false"
                      @keydown.enter.prevent="stepMatch($event.shiftKey ? -1 : 1)"
                    />
                    <button class="find-btn" :class="{ 'find-btn-on': find.matchCase }" title="Match case" @click="find.matchCase = !find.matchCase">Aa</button>
                    <span class="find-count">{{ findMatches.length ? `${findCurrent + 1} of ${findMatches.length}` : find.query ? 'No results' : '' }}</span>
                    <button class="find-btn" title="Previous match (Shift+Enter)" :disabled="!findMatches.length" @click="stepMatch(-1)">
                      <i class="bi bi-arrow-up"></i>
                    </button>
                    <button class="find-btn" title="Next match (Enter)" :disabled="!findMatches.length" @click="stepMatch(1)">
                      <i class="bi bi-arrow-down"></i>
                    </button>
                    <button class="find-btn" title="Close (Esc)" @click="closeFind">
                      <i class="bi bi-x-lg"></i>
                    </button>
                  </div>
                  <div v-if="find.replace" class="find-row find-row-replace">
                    <input
                      v-model="find.replacement"
                      class="find-input"
                      placeholder="Replace"
                      spellcheck="false"
                      @keydown.enter.prevent="replaceCurrent"
                    />
                    <button class="find-btn find-btn-text" title="Replace (Enter)" :disabled="!findMatches.length" @click="replaceCurrent">Replace</button>
                    <button class="find-btn find-btn-text" title="Replace all" :disabled="!findMatches.length" @click="replaceAll">All</button>
                  </div>
                </div>
              </template>
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

.editor-sidebar-resize,
.editor-split-resize {
  flex-shrink: 0;
  width: 5px;
  cursor: ew-resize;
  background: #3e3d32;
}
.editor-sidebar-resize:hover,
.editor-sidebar-resize:active,
.editor-split-resize:hover,
.editor-split-resize:active {
  background: #4e4d40;
}
.editor-split-resize { order: 1; }
.editor-split-column { flex-direction: column; }
.editor-split-column .editor-split-resize { width: auto; height: 5px; cursor: ns-resize; }
.editor-split-column .editor-window-body { min-height: 0; }
.editor-split-column .editor-state { min-height: 0; }

.editor-drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
}
.editor-drop-highlight {
  position: absolute;
  pointer-events: none;
  background: rgba(127, 180, 224, 0.18);
  border: 2px solid rgba(127, 180, 224, 0.6);
  transition: inset 0.1s ease, width 0.1s ease, height 0.1s ease;
}

/* One strip per pane in the titlebar; only the focused pane's active tab
   keeps the accent underline, marking what Save/Download/Ctrl+S act on. */
.editor-toolbar-panes {
  display: flex;
  flex: 1;
  min-width: 0;
}
.editor-toolbar-pane {
  display: flex;
  min-width: 0;
}
/* Above the drop overlay (z-index 5), so dropping on it still hits the strip. */
.editor-pane-strip {
  position: relative;
  z-index: 6;
  order: 2;
  flex-shrink: 0;
  background: #2b2b2b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.editor-toolbar-pane + .editor-toolbar-pane {
  border-left: 1px solid rgba(255, 255, 255, 0.18);
}
.editor-toolbar-pane-unfocused :deep(.tab-active) {
  box-shadow: none;
}
.editor-toolbar-pane-drop {
  background: rgba(127, 180, 224, 0.18);
  box-shadow: inset 0 0 0 2px rgba(127, 180, 224, 0.6);
}

.editor-tabs-area {
  position: relative;
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
.editor-find-marks,
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

/* ── Find / replace ── */
.editor-find-marks {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  color: transparent;
}
.editor-find-marks :deep(mark) {
  padding: 0;
  color: transparent;
  background: rgba(230, 219, 116, 0.25);
  border-radius: 2px;
}
.editor-find-marks :deep(mark.find-current) {
  background: rgba(253, 151, 31, 0.5);
  outline: 1px solid #fd971f;
}
.find-bar {
  position: absolute;
  top: 0.4rem;
  right: 1.5rem;
  z-index: 2;
  max-width: calc(100% - 2rem);
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.35rem 0.4rem;
  background: #272822;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
  font-size: 0.78rem;
  color: #e2e2df;
}
.find-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
/* Lines the replace input up under the find input (past the toggle button). */
.find-row-replace { padding-left: 1.75rem; }
.find-input {
  width: 14rem;
  min-width: 3rem;
  flex-shrink: 1;
  padding: 0.2rem 0.4rem;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  outline: none;
  background: #1e1e1e;
  color: #f8f8f2;
  font: inherit;
}
.find-input:focus { border-color: #7fb4e0; }
.find-count {
  min-width: 4.5rem;
  color: #a6a69c;
  white-space: nowrap;
}
.find-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.5rem;
  height: 1.5rem;
  padding: 0 0.25rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.find-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
.find-btn:disabled { opacity: 0.4; cursor: default; }
.find-btn-on { border-color: #7fb4e0; color: #7fb4e0; }
.find-btn-text { padding: 0 0.5rem; }

/* ── Review mode ── */
.review-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #1e1e1e;
}
.review-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
  padding: 0.3rem 0.5rem 0.3rem 0.75rem;
  background: #272822;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  color: #e2e2df;
  font-size: 0.78rem;
}
.review-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-toggle {
  display: inline-flex;
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  overflow: hidden;
}
.review-toggle button {
  border: 0;
  background: transparent;
  color: #a9a9a9;
  font-size: 0.72rem;
  padding: 0.15rem 0.5rem;
  cursor: pointer;
}
.review-toggle button + button { border-left: 1px solid rgba(255, 255, 255, 0.15); }
.review-toggle button:hover { color: #e2e2df; }
.review-toggle .review-toggle-on { background: rgba(255, 255, 255, 0.12); color: #fff; }
.review-stat-added { color: #7ec699; font-weight: 600; }
.review-stat-removed { color: #f07178; font-weight: 600; }
.review-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  min-width: 24px;
  height: 24px;
  padding: 0 0.3rem;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}
.review-btn:hover { background: rgba(255, 255, 255, 0.1); }
.review-btn-text { padding: 0 0.55rem; border: 1px solid rgba(255, 255, 255, 0.15); }

/* position: relative makes it the rows' offsetParent (see jumpToChange). */
.review-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0.5rem 0;
  font-size: 0.85rem;
  line-height: 1.6;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  color: #f8f8f2;
}
.review-line { display: flex; }
.review-line-added { background: rgba(126, 198, 153, 0.14); }
.review-line-removed { background: rgba(240, 113, 120, 0.14); }
.review-no {
  flex-shrink: 0;
  width: 4.5ch;
  padding-right: 0.75ch;
  text-align: right;
  color: #75715e;
  user-select: none;
}
.review-sign {
  flex-shrink: 0;
  width: 2ch;
  text-align: center;
  user-select: none;
}
.review-line-added .review-sign { color: #7ec699; }
.review-line-removed .review-sign { color: #f07178; }
.review-text {
  flex: 1;
  min-width: 0;
  padding-right: 1rem;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  tab-size: 4;
}
/* Same as .editor-highlight: bold/italic theme styles shift glyph widths. */
.review-text :deep(*) {
  font-weight: inherit;
  font-style: inherit;
}
.review-fold {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.15rem 0 0.15rem 10.5ch;
  border: 0;
  border-block: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(127, 180, 224, 0.08);
  color: #7fb4e0;
  font: inherit;
  font-size: 0.78rem;
  text-align: left;
  cursor: pointer;
}
.review-fold:hover { background: rgba(127, 180, 224, 0.16); }

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
