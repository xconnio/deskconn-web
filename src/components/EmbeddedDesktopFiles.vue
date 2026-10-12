<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { ApplicationError, type Session } from 'xconn'

import { useSessionCacheStore } from '@/stores/sessionCache'
import { useSessionEncryptionStore } from '@/stores/sessionEncryption'
import { useSettingsStore } from '@/stores/settings'
import { useEntryNavigation } from '@/composables/useEntryNavigation'
import EmbeddedIndexedFiles from '@/components/EmbeddedIndexedFiles.vue'
import { floatingWindowActionsKey, floatingWindowMobileKey, floatingWindowToolbarKey } from '@/composables/floatingWindowToolbar'
import type { FileBrowseResult, FileEntry } from '@/types'
import { parseFileEntry, createFileBrowser } from '@/utils/fileBrowse'
import {
  encryptPayload,
  decryptPayload,
  type EncryptionKeys,
} from '@/utils/encryption'
import { uploadFileToPath } from '@/utils/fileUpload'
import { downloadFile, ensureDownloadServiceWorker, type DownloadProgressState } from '@/utils/fileDownload'
import { formatSize, getFilePreviewType, isFirefoxBrowser } from '@/utils/fileTypes'
import { formatDesktopError, isDesktopOfflineError, isNoSuchProcedureException } from '@/utils/desktopError'
import {
  baseName,
  detectPathSeparator,
  dirName,
  isAbsolutePath,
  isPathWithinHome,
  joinPath,
  relativeSegments,
} from '@/utils/filePath'

const procedureFileRename = 'io.xconn.deskconn.deskconnd.file.rename'
const procedureFileDelete = 'io.xconn.deskconn.deskconnd.file.delete'
const procedureFileCopy = 'io.xconn.deskconn.deskconnd.file.copy'
const procedureFileSearch = 'io.xconn.deskconn.deskconnd.file.search'
const outsideHomeMessage = 'Access denied. You can only browse files inside the home directory.'
const PAGE_SIZE = 100

const props = defineProps<{
  realm: string
  desktopName?: string
  initialPath?: string
  initialOpenFile?: string
  focused?: boolean
}>()

const emit = defineEmits<{
  'preview-file': [session: Session, entry: { path: string; name: string; size: number }, entries: { path: string; name: string; size: number }[]]
  'open-text-editor': [session: Session, entry: FileEntry]
  // Not emitted by this component — declared so Vue treats the listeners
  // DesktopSessionHost.vue binds generically to every app window (@close,
  // @open-files, @update-title) as custom events rather than attrs it tries
  // (and, with this component's multi-root template, fails) to inherit.
  close: []
  'open-files': [path: string]
  'update-title': [title: string]
}>()

type Place = 'files' | 'documents' | 'pictures' | 'videos'

const allPlaces: { id: Place; label: string; icon: string }[] = [
  { id: 'documents', label: 'Documents', icon: 'bi-file-earmark-text' },
  { id: 'pictures', label: 'Pictures', icon: 'bi-image' },
  { id: 'videos', label: 'Videos', icon: 'bi-film' },
]

// Documents, Pictures and Videos are served by media-app: deskconnd lists them in
// capabilities.list while it's running. Older backends, without that list, index files
// themselves, so every place stays.
const procedureCapabilitiesList = 'io.xconn.deskconn.deskconnd.capabilities.list'
const listedApps = ref<string[] | null>(null)
const places = computed(() =>
  listedApps.value === null ? allPlaces : allPlaces.filter((p) => listedApps.value?.includes(p.id)),
)

async function fetchListedApps() {
  listedApps.value = null
  if (!session.value) return
  try {
    const result = await session.value.call(procedureCapabilitiesList)
    const apps = (result.args?.[0] ?? []) as { id: string; enabled: boolean }[]
    listedApps.value = apps.filter((a) => a.enabled).map((a) => a.id)
  } catch {
    // Older backend: keep every place.
  }
}

const activePlace = ref<Place>('files')

// The indexed view's "View in Files" context menu item routes back here with
// the file's full path — open its containing folder and highlight it.
async function onIndexOpenFiles(filePath: string) {
  activePlace.value = 'files'
  await loadPath(dirName(filePath))
  selectedEntry.value = currentBrowse.value?.entries?.find((e) => e.name === baseName(filePath)) ?? null
  await nextTick()
  entryListRef.value?.querySelector<HTMLElement>('.entry-row.active')?.scrollIntoView({ block: 'center' })
}

const sessionCacheStore = useSessionCacheStore()
const sessionEncryptionStore = useSessionEncryptionStore()
const settingsStore = useSettingsStore()

// Absent when there's no FloatingWindow ancestor (e.g. the standalone /files
// route) — the toolbar then renders inline instead of teleporting.
const toolbarHostRef = inject(floatingWindowToolbarKey)
const toolbarTarget = computed(() => toolbarHostRef?.value ?? null)
// Phone layout: search/upload/settings move up into the window's app bar,
// leaving the toolbar row to history navigation and the path.
const actionsHostRef = inject(floatingWindowActionsKey)
const windowMobile = inject(floatingWindowMobileKey, null)
const appBarTarget = computed(() => (windowMobile?.value ? actionsHostRef?.value ?? null : null))

const session = shallowRef<Session | null>(null)
const encryptionKeys = ref<EncryptionKeys | null>(null)
const isConnecting = ref(true)
const isLoading = ref(false)
const errorMessage = ref('')
const currentBrowse = ref<FileBrowseResult | null>(null)
const nextCursor = ref<string | undefined>(undefined)
const hasMore = ref(false)
const isLoadingMore = ref(false)
const selectedEntry = ref<FileEntry | null>(null)
const pathInput = ref('')
const showHiddenFiles = ref(false)
const searchMode = ref(false)
const entryListRef = ref<HTMLElement | null>(null)
const explorerShellRef = ref<HTMLElement | null>(null)

const actionSheetEntry = ref<FileEntry | null>(null)
const actionSheetVisible = ref(false)
const dropdownPos = ref<{ top: number; right: number } | null>(null)
const showRenameDialog = ref(false)
const showDeleteDialog = ref(false)
const renameInput = ref('')
const clipboard = ref<FileEntry | null>(null)
const isOperating = ref(false)
const operationError = ref('')
const supportedFileProcedures = ref({
  rename: false,
  delete: false,
  copy: false,
})

const navHistory = ref<string[]>([])
const navHistoryIndex = ref(-1)

const fileSearchActive = ref(false)
const fileSearchQuery = ref('')
const fileSearchResults = ref<FileEntry[]>([])
const fileSearching = ref(false)
const fileSearchError = ref('')
let searchGeneration = 0

const canGoBack = computed(() => navHistoryIndex.value > 0)
const canGoForward = computed(() => navHistoryIndex.value < navHistory.value.length - 1)

const visibleSearchResults = computed(() => {
  if (!showHiddenFiles.value) {
    return fileSearchResults.value.filter(e => !e.hidden && !e.name.startsWith('.'))
  }
  return fileSearchResults.value
})

const hoveredEntry = ref<FileEntry | null>(null)

const thumbnailUrls = reactive<Record<string, string>>({})

const selectionStatus = computed(() => {
  const entry = hoveredEntry.value ?? selectedEntry.value
  if (!entry) return ''
  if (entry.is_dir) {
    const count = entry.item_count ?? 0
    return `"${entry.name}" selected (containing ${count} ${count === 1 ? 'item' : 'items'})`
  }
  return `"${entry.name}" selected (${formatSize(entry.size)})`
})

const isGridView = ref(false)
const backgroundMenuVisible = ref(false)
const backgroundMenuPos = ref<{ x: number; y: number } | null>(null)
const propertiesModalVisible = ref(false)
const propertiesModalEntry = ref<FileEntry | null>(null)
const settingsMenuVisible = ref(false)
const settingsMenuPos = ref<{ x: number; y: number } | null>(null)
const settingsBtnRef = ref<HTMLElement | null>(null)

const downloadProgress = ref<DownloadProgressState | null>(null)

const uploadInputRef = ref<HTMLInputElement | null>(null)
type UploadProgressState = {
  name: string
  sent: number
  total: number
  speed: number
  cancel: () => void
}
const uploadProgress = ref<UploadProgressState | null>(null)

const breadcrumbSegments = computed(() => {
  const browse = currentBrowse.value
  if (!browse) return []

  const homePath = normalizePathValue(browse.home_path)
  const currentPath = normalizePathValue(browse.path)

  if (currentPath === homePath) {
    return [{ label: 'Home', path: homePath }]
  }

  const parts = relativeSegments(currentPath, homePath)

  if (parts.length === 0) {
    return [{ label: homePath, path: currentPath }]
  }

  const sep = detectPathSeparator(homePath)
  const segments = [{ label: 'Home', path: homePath }]
  let runningPath = homePath

  for (const part of parts) {
    runningPath = `${runningPath}${sep}${part}`
    segments.push({ label: part, path: runningPath })
  }

  return segments
})

const breadcrumbStripRef = ref<HTMLElement | null>(null)
let breadcrumbResizeObserver: ResizeObserver | null = null

// Keeps the current (rightmost) segment in view instead of the home segment
// scroll defaults to — matters most when the window is narrow or the path is deep.
function scrollBreadcrumbToEnd() {
  const el = breadcrumbStripRef.value
  if (el) el.scrollLeft = el.scrollWidth
}

// Most mice only scroll vertically; without this, a horizontally-overflowing
// breadcrumb with its scrollbar hidden would be unreachable by wheel at all.
function onBreadcrumbWheel(e: WheelEvent) {
  const el = breadcrumbStripRef.value
  if (!el || el.scrollWidth <= el.clientWidth) return
  e.preventDefault()
  el.scrollLeft += e.deltaY
}

watch(breadcrumbSegments, () => {
  void nextTick(() => scrollBreadcrumbToEnd())
})

// The strip only exists once currentBrowse first loads (v-if), so the
// ResizeObserver has to be attached reactively rather than once in onMounted.
watch(breadcrumbStripRef, (el, prevEl) => {
  if (prevEl) breadcrumbResizeObserver?.disconnect()
  if (el) {
    breadcrumbResizeObserver = new ResizeObserver(() => scrollBreadcrumbToEnd())
    breadcrumbResizeObserver.observe(el)
  }
})

const canGoUp = computed(() => {
  if (!currentBrowse.value) return false

  return (
    Boolean(currentBrowse.value.parent_path) &&
    normalizePathValue(currentBrowse.value.path) !==
      normalizePathValue(currentBrowse.value.home_path)
  )
})

const visibleEntries = computed(() => {
  const entries = currentBrowse.value?.entries || []
  if (showHiddenFiles.value) return entries

  return entries.filter((entry) => !entry.hidden && !entry.name.startsWith('.'))
})

const hasEntryActions = computed(
  () =>
    supportedFileProcedures.value.rename ||
    supportedFileProcedures.value.delete ||
    supportedFileProcedures.value.copy,
)

const canDownload = computed(() => !!session.value)

function entryHasMenu(entry: FileEntry) {
  if (entry.is_symlink) return true
  if (!entry.is_dir) return canDownload.value
  return hasEntryActions.value
}

function normalizePathValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function formatError(error: unknown) {
  if (isDesktopOfflineError(error)) sessionCacheStore.reportUnreachable(props.realm)

  const invalidPathMessage = 'Invalid path.'

  if (error instanceof ApplicationError || error instanceof Error) {
    const message = (error.message || '').toLowerCase()
    if (
      message.includes('relative path escapes home') ||
      message.includes('outside the home directory')
    ) {
      return outsideHomeMessage
    }
    if (
      message.includes('no such file') ||
      message.includes('not exist') ||
      message.includes('invalid path') ||
      message.includes('invalid argument')
    ) {
      return invalidPathMessage
    }
  }

  return formatDesktopError(error)
}

function formatDate(value?: string) {
  if (!value) return 'Unknown'

  const numericValue = Number(value)
  const parsedValue =
    Number.isFinite(numericValue) && value.trim() !== ''
      ? numericValue < 1e12
        ? numericValue * 1000
        : numericValue
      : value

  const date = new Date(parsedValue)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function iconClassForEntry(entry: FileEntry) {
  if (entry.is_dir) return 'bi-folder-fill'
  if (entry.is_symlink) return 'bi-signpost-split-fill'

  const lowered = entry.name.toLowerCase()
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/.test(lowered)) return 'bi-image-fill'
  if (/\.(zip|tar|gz|xz|7z|rar|bz2)$/.test(lowered)) return 'bi-file-earmark-zip-fill'
  if (/\.(mp3|ogg|wav|flac|aac|m4a|opus)$/.test(lowered)) return 'bi-file-earmark-music-fill'
  if (/\.(mp4|webm|mov|ogv|avi|mkv)$/.test(lowered)) return 'bi-file-earmark-play-fill'
  if (/\.(pdf)$/.test(lowered)) return 'bi-file-earmark-pdf-fill'
  if (/\.(json|yaml|yml|toml|xml|ini|conf|env)$/.test(lowered)) return 'bi-filetype-yml'
  if (/\.(md|txt|log)$/.test(lowered)) return 'bi-file-earmark-text-fill'
  if (/\.(sh|bash|zsh|py|js|ts|jsx|tsx|go|rs|c|cpp|h|hpp|java|rb|php|vue|svelte|sql|css|html|htm)$/.test(lowered)) return 'bi-file-earmark-code-fill'

  return 'bi-file-earmark-fill'
}

function iconStyleForEntry(entry: FileEntry): { color: string; background: string } {
  if (entry.is_dir) return { color: '#334155', background: '#e2e8f0' }
  if (entry.is_symlink) return { color: '#a78bfa', background: '#ede9fe' }

  const lowered = entry.name.toLowerCase()
  if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/.test(lowered)) return { color: '#f472b6', background: '#fce7f3' }
  if (/\.(zip|tar|gz|xz|7z|rar|bz2)$/.test(lowered)) return { color: '#fb923c', background: '#ffedd5' }
  if (/\.(mp3|ogg|wav|flac|aac|m4a|opus)$/.test(lowered)) return { color: '#60a5fa', background: '#dbeafe' }
  if (/\.(mp4|webm|mov|ogv|avi|mkv)$/.test(lowered)) return { color: '#818cf8', background: '#e0e7ff' }
  if (/\.(pdf)$/.test(lowered)) return { color: '#f87171', background: '#fee2e2' }
  if (/\.(json|yaml|yml|toml|xml|ini|conf|env)$/.test(lowered)) return { color: '#34d399', background: '#d1fae5' }
  if (/\.(md|txt|log)$/.test(lowered)) return { color: '#94a3b8', background: '#f1f5f9' }
  if (/\.(sh|bash|zsh|py|js|ts|jsx|tsx|go|rs|c|cpp|h|hpp|java|rb|php|vue|svelte|sql|css|html|htm)$/.test(lowered)) return { color: '#a855f7', background: '#f5f3ff' }

  return { color: '#94a3b8', background: '#f8fafc' }
}

function disconnectDesktopSession() {
  session.value = null
}

function resetExplorerState() {
  currentBrowse.value = null
  selectedEntry.value = null
  pathInput.value = ''
  errorMessage.value = ''
  isLoading.value = false
  nextCursor.value = undefined
  hasMore.value = false
  isLoadingMore.value = false
  fileBrowser = null
  encryptionKeys.value = null
  navHistory.value = []
  navHistoryIndex.value = -1
  supportedFileProcedures.value = {
    rename: false,
    delete: false,
    copy: false,
  }
  clipboard.value = null
  closeActionSheet()
  searchGeneration++
  fileSearchActive.value = false
  fileSearchQuery.value = ''
  fileSearchResults.value = []
  fileSearchError.value = ''
  fileSearching.value = false
}

async function performKeyExchange(): Promise<boolean> {
  if (!session.value) return false

  // Shared across every window on this realm's session (see
  // sessionEncryption.ts) — the backend keeps only one key per session, so
  // Files/Pictures/an Image Viewer save all have to reuse the same one.
  try {
    encryptionKeys.value = await sessionEncryptionStore.getOrExchange(session.value, props.realm)
    return true
  } catch (error) {
    if (isNoSuchProcedureException(error)) {
      return false
    }
    throw error
  }
}

async function probeFileOperation(procedure: string): Promise<boolean> {
  if (!session.value || !encryptionKeys.value) return false

  try {
    await callFileOperation(procedure, {})
    return true
  } catch (error) {
    if (isNoSuchProcedureException(error)) {
      return false
    }

    return true
  }
}

async function detectFileOperationSupport() {
  if (!session.value || !encryptionKeys.value) {
    supportedFileProcedures.value = {
      rename: false,
      delete: false,
      copy: false,
    }
    clipboard.value = null
    closeActionSheet()
    return
  }

  const [rename, deleteItem, copy] = await Promise.all([
    probeFileOperation(procedureFileRename),
    probeFileOperation(procedureFileDelete),
    probeFileOperation(procedureFileCopy),
  ])

  supportedFileProcedures.value = {
    rename,
    delete: deleteItem,
    copy,
  }

  if (!copy) {
    clipboard.value = null
  }

  if (!hasEntryActions.value) {
    closeActionSheet()
  }
}

// Reassigned per connection in connectDesktopSession — file.browse's
// pre-pagination-protocol fallback state (see fileBrowse.ts) must reset when
// the session does.
let fileBrowser: ReturnType<typeof createFileBrowser> | null = null

async function browseFiles(path: string, cursor?: string): Promise<FileBrowseResult> {
  return fileBrowser!.browseFiles(path, cursor, PAGE_SIZE)
}

async function loadPath(path = '', skipHistory = false) {
  if (!session.value) return

  isLoading.value = true
  errorMessage.value = ''
  nextCursor.value = undefined
  hasMore.value = false

  const requestedPath = path.trim()
  const homePath = normalizePathValue(currentBrowse.value?.home_path)
  if (
    requestedPath &&
    isAbsolutePath(requestedPath) &&
    homePath &&
    !isPathWithinHome(requestedPath, homePath)
  ) {
    errorMessage.value = outsideHomeMessage
    isLoading.value = false
    return
  }

  try {
    const browse = await browseFiles(requestedPath)

    if (!isPathWithinHome(browse.path, browse.home_path)) {
      throw new Error('Outside the home directory')
    }

    currentBrowse.value = browse
    pathInput.value = browse.path
    selectedEntry.value = null
    nextCursor.value = browse.next_cursor
    hasMore.value = browse.has_more ?? false

    if (!skipHistory) {
      navHistory.value = navHistory.value.slice(0, navHistoryIndex.value + 1)
      navHistory.value.push(browse.path)
      navHistoryIndex.value = navHistory.value.length - 1
    }
  } catch (error) {
    errorMessage.value = formatError(error)
  } finally {
    isLoading.value = false
  }

  await nextTick()
  maybeLoadMore()
}

async function loadMore() {
  if (!hasMore.value || isLoadingMore.value) return
  if (!session.value || !currentBrowse.value) return

  isLoadingMore.value = true
  try {
    const browse = await browseFiles(currentBrowse.value.path, nextCursor.value)
    currentBrowse.value = {
      ...currentBrowse.value,
      entries: [...(currentBrowse.value.entries ?? []), ...(browse.entries ?? [])],
    }
    nextCursor.value = browse.next_cursor
    hasMore.value = browse.has_more ?? false
  } catch (error) {
    errorMessage.value = formatError(error)
  } finally {
    isLoadingMore.value = false
  }

  await nextTick()
  maybeLoadMore()
}

function maybeLoadMore() {
  const el = explorerShellRef.value
  if (!el || !hasMore.value || isLoadingMore.value) return
  if (el.scrollHeight <= el.clientHeight + 200) {
    void loadMore()
  }
}

function handleScroll() {
  // Pictures/Documents/Videos share this scroll area but load their own pages.
  if (activePlace.value !== 'files') return
  const el = explorerShellRef.value
  if (!el) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
    void loadMore()
  }
}

async function connectDesktopSession() {
  isConnecting.value = true
  errorMessage.value = ''

  try {
    session.value = await sessionCacheStore.acquire(props.realm)
    fileBrowser = session.value ? createFileBrowser(session.value, () => encryptionKeys.value) : null
  } catch (error) {
    errorMessage.value = formatError(error)
    session.value = null
    fileBrowser = null
  } finally {
    isConnecting.value = false
  }
}

async function initializeExplorer() {
  resetExplorerState()
  disconnectDesktopSession()
  await connectDesktopSession()

  if (!session.value) return
  void fetchListedApps()

  try {
    await performKeyExchange()
  } catch (error) {
    errorMessage.value = formatError(error)
    return
  }

  await detectFileOperationSupport()

  await loadPath(props.initialPath ?? '')

  if (props.initialOpenFile && currentBrowse.value) {
    const target = currentBrowse.value.entries?.find(e => e.name === props.initialOpenFile)
    if (target && !target.is_dir) openPreview(target)
  }
}

async function goUp() {
  if (!currentBrowse.value?.parent_path || !canGoUp.value) return
  await loadPath(currentBrowse.value.parent_path)
}

async function goBack() {
  if (!canGoBack.value) return
  navHistoryIndex.value--
  await loadPath(navHistory.value[navHistoryIndex.value], true)
}

async function goForward() {
  if (!canGoForward.value) return
  navHistoryIndex.value++
  await loadPath(navHistory.value[navHistoryIndex.value], true)
}

async function refreshCurrentPath() {
  await loadPath(currentBrowse.value?.path || '', true)
}

function selectEntry(entry: FileEntry) {
  selectedEntry.value = entry
}

// Resolves a symlink's link_target to an absolute path so the backend receives
// a plain file path. The backend uses Lstat for the download-header size; on a
// symlink Lstat returns the target-path length, not the file size, causing a
// stream-length mismatch. A resolved path avoids that entirely.
function resolveSymlinkTarget(entry: FileEntry): string | null {
  const target = entry.link_target
  if (!target) return null
  if (isAbsolutePath(target)) return target

  const sep = detectPathSeparator(entry.path)
  const parentDir = dirName(entry.path)
  const parts = `${parentDir}${sep}${target}`.split(sep)
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..' && resolved.length > 0) resolved.pop()
    else if (part !== '.' && part !== '') resolved.push(part)
  }
  return sep === '\\' && /^[a-zA-Z]:$/.test(resolved[0] ?? '')
    ? resolved.join(sep)
    : sep + resolved.join(sep)
}

async function openEntry(entry: FileEntry) {
  if (entry.is_dir) {
    await loadPath(entry.path)
    return
  }

  if (entry.is_symlink) {
    // The backend uses Lstat, so the symlink path itself shows is_dir = false even
    // for directory symlinks, and gives the wrong size for files. Browse and download
    // the resolved target path directly so Lstat operates on the actual target.
    const resolvedPath = resolveSymlinkTarget(entry)
    const browsePath = resolvedPath ?? entry.path

    const prevBrowse = currentBrowse.value
    const prevHistory = navHistory.value.slice()
    const prevIndex = navHistoryIndex.value

    await loadPath(browsePath)

    if (currentBrowse.value?.is_dir) return  // directory symlink: navigation succeeded

    // File symlink: revert state and open the file.
    currentBrowse.value = prevBrowse
    navHistory.value = prevHistory
    navHistoryIndex.value = prevIndex
    if (prevBrowse) pathInput.value = prevBrowse.path

    openPreview(resolvedPath ? { ...entry, path: resolvedPath } : entry)
    return
  }

  selectEntry(entry)
}

async function submitPath() {
  await loadPath(pathInput.value.trim())
  searchMode.value = false
}

function enterSearchMode() {
  searchMode.value = true
  pathInput.value = currentBrowse.value?.path || ''
  nextTick(() => {
    const input = document.querySelector('.path-input') as HTMLInputElement | null
    if (input) {
      input.focus()
      input.select()
    }
  })
}

function exitSearchMode() {
  searchMode.value = false
}

function openActionSheet(entry: FileEntry, event: MouseEvent) {
  const btn = event.currentTarget as HTMLElement
  const rect = btn.getBoundingClientRect()
  const dropdownHeight = 164 // approx height of 4 items
  const fitsBelow = rect.bottom + dropdownHeight + 8 < window.innerHeight
  dropdownPos.value = {
    top: fitsBelow ? rect.bottom + 6 : rect.top - dropdownHeight - 6,
    right: Math.max(4, window.innerWidth - rect.right),
  }
  actionSheetEntry.value = entry
  actionSheetVisible.value = true
  operationError.value = ''
}

function closeActionSheet() {
  actionSheetVisible.value = false
  actionSheetEntry.value = null
  showRenameDialog.value = false
  showDeleteDialog.value = false
  operationError.value = ''
}

// Opens a file in its own preview window (see FilePreviewModal.vue — handles type
// detection, streaming audio/video over WebRTC, and buffered preview for
// images/pdf/text internally).
function openPreview(entry: FileEntry) {
  if (entry.is_dir) return
  selectEntry(entry)
  if (!session.value) return
  emit('preview-file', session.value, entry, visibleEntries.value)
}

async function downloadFileToClient(entry: FileEntry) {
  if (entry.is_dir || !session.value) return
  await downloadFile(session.value, props.realm, entry, downloadProgress, (err) => {
    operationError.value = err instanceof Error ? err.message : 'Download failed'
  })
}

function triggerUpload() {
  uploadInputRef.value?.click()
}

async function onUploadFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || !currentBrowse.value) return
  for (const file of files) {
    await uploadFileToRemote(file)
  }
}

async function uploadFileToRemote(file: File) {
  if (!session.value || !currentBrowse.value) return

  const destPath = currentBrowse.value.path
  const controller = new AbortController()

  uploadProgress.value = {
    name: file.name,
    sent: 0,
    total: file.size,
    speed: 0,
    cancel: () => controller.abort(),
  }

  try {
    await uploadFileToPath(session.value, props.realm, destPath, file.name, file, (p) => {
      if (!uploadProgress.value) return
      uploadProgress.value.sent = p.sent
      uploadProgress.value.total = p.total
      uploadProgress.value.speed = p.speed
    }, controller.signal)
    await refreshCurrentPath()
  } catch (err) {
    // On abort, uploadFileToPath already tells the backend to discard its
    // per-session upload state before rethrowing — nothing left to surface.
    if (!controller.signal.aborted) {
      operationError.value = err instanceof Error ? err.message : 'Upload failed'
    }
  } finally {
    uploadProgress.value = null
  }
}

function enterFileSearch() {
  fileSearchActive.value = true
  fileSearchQuery.value = ''
  fileSearchResults.value = []
  fileSearchError.value = ''
  fileSearching.value = false
  nextTick(() => {
    const input = document.querySelector('.file-search-input') as HTMLInputElement | null
    if (input) input.focus()
  })
}

function exitFileSearch() {
  searchGeneration++
  fileSearchActive.value = false
  fileSearchQuery.value = ''
  fileSearchResults.value = []
  fileSearchError.value = ''
  fileSearching.value = false
}

function onSearchQueryInput() {
  const q = fileSearchQuery.value.trim()
  if (!q) {
    fileSearchResults.value = []
    fileSearching.value = false
    return
  }
  void executeSearch(q)
}

async function executeSearch(query: string) {
  if (!session.value || !encryptionKeys.value) return
  const gen = ++searchGeneration
  const keys = encryptionKeys.value
  const searchPath = currentBrowse.value?.path || ''

  fileSearchResults.value = []
  fileSearchError.value = ''
  fileSearching.value = true

  try {
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({ path: searchPath, query, show_hidden: showHiddenFiles.value }),
    )
    const encrypted = encryptPayload(payloadBytes, keys.encryptKey)

    type CallResult = Awaited<ReturnType<Session['call']>>
    const progressResult: any = await session.value.callProgress(procedureFileSearch, [encrypted]) // eslint-disable-line @typescript-eslint/no-explicit-any

    progressResult.registerProgress((result: CallResult) => {
      if (gen !== searchGeneration) return
      try {
        const encryptedMsg = result.args?.[0] as Uint8Array
        if (!encryptedMsg?.length) return
        const decrypted = decryptPayload(encryptedMsg, keys.decryptKey)
        const parsed = JSON.parse(new TextDecoder().decode(decrypted))
        if (Array.isArray(parsed)) {
          fileSearchResults.value.push(...(parsed as unknown[]).map(parseFileEntry))
        } else if (parsed && typeof parsed === 'object' && 'path' in parsed && 'thumbnail' in parsed) {
          const { path, thumbnail } = parsed as { path: string; thumbnail: string }
          if (thumbnail) thumbnailUrls[path] = `data:image/jpeg;base64,${thumbnail}`
        }
      } catch { /* ignore malformed messages */ }
    })

    await progressResult.finalResultPromise
  } catch (err) {
    if (gen === searchGeneration) {
      fileSearchError.value = err instanceof Error ? err.message : 'Search failed'
    }
  } finally {
    if (gen === searchGeneration) fileSearching.value = false
  }
}

function searchResultParent(entry: FileEntry): string {
  const root = currentBrowse.value?.path || ''
  const sep = detectPathSeparator(entry.path)
  const parent = dirName(entry.path)
  if (parent === root) return '.'
  if (parent.startsWith(`${root}${sep}`)) return parent.slice(root.length + 1)
  return parent
}

async function openSearchResult(entry: FileEntry) {
  exitFileSearch()
  if (entry.is_dir) {
    await loadPath(entry.path)
    return
  }
  const parentDir = dirName(entry.path)
  await loadPath(parentDir)
  openPreview(entry)
}

async function openActionSheetEntry() {
  if (!actionSheetEntry.value || actionSheetEntry.value.is_dir) return
  const entry = actionSheetEntry.value
  closeActionSheet()
  openPreview(entry)
}

async function downloadActionSheetEntry() {
  if (!actionSheetEntry.value || actionSheetEntry.value.is_dir) return
  const entry = actionSheetEntry.value
  closeActionSheet()
  await downloadFileToClient(entry)
}

// Unlike openActionSheetEntry (which routes through file-type detection and
// falls back to a raw download for non-previewable types), this always opens
// in Text Editor as plain text — and works for a folder too, opening it as
// the editor's sidebar project instead of a single file tab.
function openActionSheetEntryInTextEditor() {
  if (!actionSheetEntry.value || !session.value) return
  const entry = actionSheetEntry.value
  closeActionSheet()
  emit('open-text-editor', session.value, entry)
}

function startRename() {
  if (!actionSheetEntry.value || !supportedFileProcedures.value.rename) return
  renameInput.value = actionSheetEntry.value.name
  actionSheetVisible.value = false
  showRenameDialog.value = true
  operationError.value = ''
  nextTick(() => {
    const input = document.querySelector('.rename-input') as HTMLInputElement | null
    if (input) {
      input.focus()
      input.select()
    }
  })
}

function startDelete() {
  if (!supportedFileProcedures.value.delete) return
  actionSheetVisible.value = false
  showDeleteDialog.value = true
  operationError.value = ''
}

function copyToClipboard() {
  if (!actionSheetEntry.value || !supportedFileProcedures.value.copy) return
  clipboard.value = actionSheetEntry.value
  closeActionSheet()
}

async function callFileOperation(procedure: string, payload: object): Promise<void> {
  if (!session.value || !encryptionKeys.value) {
    throw new Error('No active encrypted session. Please reconnect.')
  }

  const keys = encryptionKeys.value
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  const encrypted = encryptPayload(payloadBytes, keys.encryptKey)

  const result = await session.value.call(procedure, [encrypted])

  const encryptedResult = result.args?.[0]
  if (encryptedResult) {
    decryptPayload(encryptedResult as Uint8Array, keys.decryptKey)
  }
}

async function confirmRename() {
  if (!actionSheetEntry.value || !renameInput.value.trim() || !supportedFileProcedures.value.rename) {
    return
  }

  const newName = renameInput.value.trim()
  if (newName === actionSheetEntry.value.name) {
    showRenameDialog.value = false
    actionSheetEntry.value = null
    return
  }

  const newPath = joinPath(dirName(actionSheetEntry.value.path), newName)

  isOperating.value = true
  operationError.value = ''

  try {
    await callFileOperation(procedureFileRename, {
      old_path: actionSheetEntry.value.path,
      new_path: newPath,
    })
    if (clipboard.value?.path === actionSheetEntry.value.path) {
      clipboard.value = null
    }
    if (selectedEntry.value?.path === actionSheetEntry.value.path) {
      selectedEntry.value = null
    }
    showRenameDialog.value = false
    actionSheetEntry.value = null
    await refreshCurrentPath()
  } catch (error) {
    operationError.value = formatError(error)
  } finally {
    isOperating.value = false
  }
}

async function confirmDelete() {
  if (!actionSheetEntry.value || !supportedFileProcedures.value.delete) return

  isOperating.value = true
  operationError.value = ''

  try {
    await callFileOperation(procedureFileDelete, { path: actionSheetEntry.value.path })
    if (clipboard.value?.path === actionSheetEntry.value.path) {
      clipboard.value = null
    }
    if (selectedEntry.value?.path === actionSheetEntry.value.path) {
      selectedEntry.value = null
    }
    showDeleteDialog.value = false
    actionSheetEntry.value = null
    await refreshCurrentPath()
  } catch (error) {
    operationError.value = formatError(error)
  } finally {
    isOperating.value = false
  }
}

async function pasteClipboard() {
  if (!clipboard.value || !currentBrowse.value || !supportedFileProcedures.value.copy) return

  const srcPath = clipboard.value.path
  const dstDir = currentBrowse.value.path
  let dstPath = joinPath(dstDir, clipboard.value.name)

  if (dstPath === srcPath) {
    const name = clipboard.value.name
    const dotIndex = clipboard.value.is_dir ? -1 : name.lastIndexOf('.')
    dstPath =
      dotIndex > 0
        ? joinPath(dstDir, `${name.slice(0, dotIndex)}_copy${name.slice(dotIndex)}`)
        : joinPath(dstDir, `${name}_copy`)
  }

  isOperating.value = true
  operationError.value = ''

  try {
    await callFileOperation(procedureFileCopy, { src: srcPath, dst: dstPath })
    clipboard.value = null
    await refreshCurrentPath()
  } catch (error) {
    operationError.value = formatError(error)
  } finally {
    isOperating.value = false
  }
}

function updateViewMode() {
  isGridView.value = window.innerWidth >= 768
}

function openContextMenuAtCursor(entry: FileEntry, event: MouseEvent) {
  selectedEntry.value = entry
  const menuWidth = 185
  const menuHeight = 280
  const right = Math.max(4, window.innerWidth - Math.min(event.clientX + menuWidth, window.innerWidth - 4))
  const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8)
  dropdownPos.value = { top, right }
  actionSheetEntry.value = entry
  actionSheetVisible.value = true
  operationError.value = ''
}

function openBackgroundMenu(event: MouseEvent) {
  const menuWidth = 210
  const menuHeight = 150
  backgroundMenuPos.value = {
    x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
    y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
  }
  backgroundMenuVisible.value = true
}

function closeBackgroundMenu() {
  backgroundMenuVisible.value = false
  backgroundMenuPos.value = null
}

function toggleSettingsMenu() {
  if (settingsMenuVisible.value) { closeSettingsMenu(); return }
  const el = settingsBtnRef.value
  if (!el) return
  const menuWidth = 200
  const rect = el.getBoundingClientRect()
  settingsMenuPos.value = {
    x: Math.min(rect.left, window.innerWidth - menuWidth - 8),
    y: rect.bottom + 6,
  }
  settingsMenuVisible.value = true
}

function closeSettingsMenu() {
  settingsMenuVisible.value = false
  settingsMenuPos.value = null
}

function showPropertiesFromMenu() {
  if (actionSheetEntry.value) {
    propertiesModalEntry.value = actionSheetEntry.value
    propertiesModalVisible.value = true
  }
  closeActionSheet()
}

function closePropertiesModal() {
  propertiesModalVisible.value = false
  propertiesModalEntry.value = null
}

function handleEntryPrimaryAction(entry: FileEntry) {
  if (entry.is_dir || entry.is_symlink) {
    openEntry(entry)
  } else {
    openPreview(entry)
  }
}

const { handleNavKey } = useEntryNavigation({
  entries: () => visibleEntries.value,
  getKey: (e) => e.path,
  selected: selectedEntry,
  listRef: entryListRef,
  isGrid: () => isGridView.value,
  onOpen: handleEntryPrimaryAction,
})

function handleGlobalKeydown(e: KeyboardEvent) {
  if (!props.focused || activePlace.value !== 'files') return

  const target = e.target as HTMLElement

  if (e.key === 'Escape') {
    if (document.fullscreenElement) return // let the browser exit fullscreen first
    if (fileSearchActive.value) { exitFileSearch(); return }
    if (searchMode.value) { exitSearchMode(); return }
    if (propertiesModalVisible.value) { closePropertiesModal(); return }
    if (actionSheetVisible.value) { closeActionSheet(); return }
    if (backgroundMenuVisible.value) { closeBackgroundMenu(); return }
    if (settingsMenuVisible.value) { closeSettingsMenu(); return }
    return
  }

  if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    if (!fileSearchActive.value && currentBrowse.value) enterFileSearch()
    return
  }

  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || searchMode.value || fileSearchActive.value) return

  if (e.ctrlKey) {
    if (e.key === 'h' || e.key === 'H') { e.preventDefault(); showHiddenFiles.value = !showHiddenFiles.value }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); refreshCurrentPath() }
    return
  }

  if (propertiesModalVisible.value || actionSheetVisible.value || backgroundMenuVisible.value || settingsMenuVisible.value) return

  if (e.key === 'Backspace') {
    e.preventDefault()
    goUp()
    return
  }

  handleNavKey(e)
}

watch(showHiddenFiles, (enabled) => {
  if (enabled) return
  if (selectedEntry.value?.hidden || selectedEntry.value?.name.startsWith('.')) {
    selectedEntry.value = null
  }
})

watch(
  () => props.realm,
  async () => {
    await initializeExplorer()
  },
)

function applyThumbnails(entries: FileEntry[]) {
  for (const entry of entries) {
    if (entry.thumbnail && !thumbnailUrls[entry.path]) {
      thumbnailUrls[entry.path] = `data:image/jpeg;base64,${entry.thumbnail}`
    }
  }
}


onMounted(async () => {
  updateViewMode()
  window.addEventListener('resize', updateViewMode)
  document.addEventListener('keydown', handleGlobalKeydown)
  if (isFirefoxBrowser()) {
    void ensureDownloadServiceWorker().catch(() => {})
  }
  await initializeExplorer()
})

watch(currentBrowse, (browse) => {
  if (browse?.is_dir && browse.entries?.length) {
    applyThumbnails(browse.entries)
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', updateViewMode)
  document.removeEventListener('keydown', handleGlobalKeydown)
  breadcrumbResizeObserver?.disconnect()
  disconnectDesktopSession()
  for (const url of Object.values(thumbnailUrls)) URL.revokeObjectURL(url)
})

</script>

<template>
  <div class="embedded-explorer">
    <nav class="places-sidebar">
      <button
        class="place-btn"
        :class="{ 'place-btn--active': activePlace === 'files' && breadcrumbSegments.length === 1 }"
        :disabled="activePlace === 'files' && (isConnecting || isLoading)"
        @click="activePlace = 'files'; loadPath()"
      >
        <i class="bi bi-house"></i>Home
      </button>
      <button
        v-for="p in places"
        :key="p.id"
        class="place-btn"
        :class="{ 'place-btn--active': activePlace === p.id }"
        @click="activePlace = p.id"
      >
        <i class="bi" :class="p.icon"></i>{{ p.label }}
      </button>
    </nav>
    <div class="explorer-shell" ref="explorerShellRef" @scroll="handleScroll">
      <section class="toolbar-card" :class="{ 'toolbar-card--embedded': !!toolbarTarget }">
      <Teleport :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
        <div class="path-toolbar" :class="{ 'path-toolbar--embedded': !!toolbarTarget, 'path-toolbar--mobile': !!appBarTarget }">
          <button
            class="tool-btn"
            @click="goBack"
            :disabled="activePlace !== 'files' || !canGoBack || isLoading || isConnecting"
            title="Go back"
          >
            <i class="bi bi-arrow-left"></i>
          </button>
          <button
            class="tool-btn"
            @click="goForward"
            :disabled="activePlace !== 'files' || !canGoForward || isLoading || isConnecting"
            title="Go forward"
          >
            <i class="bi bi-arrow-right"></i>
          </button>
          <button
            class="tool-btn"
            @click="refreshCurrentPath"
            :disabled="activePlace !== 'files' || isLoading || isConnecting"
            title="Refresh"
          >
            <i class="bi bi-arrow-clockwise"></i>
          </button>
          <Teleport :to="appBarTarget ?? 'body'" :disabled="!appBarTarget">
          <button
            class="tool-btn"
            :class="{ 'tool-btn--active': fileSearchActive }"
            @click="fileSearchActive ? exitFileSearch() : enterFileSearch()"
            :disabled="activePlace !== 'files' || isConnecting || !currentBrowse"
            title="Search (Ctrl+F)"
          >
            <i class="bi bi-search"></i>
          </button>
          <button
            class="tool-btn"
            @click="triggerUpload"
            :disabled="activePlace !== 'files' || isConnecting || !currentBrowse?.is_dir || isLoading"
            title="Upload files"
          >
            <i class="bi bi-cloud-upload"></i>
          </button>
          <button
            ref="settingsBtnRef"
            class="tool-btn"
            :class="{ 'tool-btn--active': settingsMenuVisible }"
            @click="toggleSettingsMenu"
            :disabled="activePlace !== 'files'"
            title="Settings"
          >
            <i class="bi bi-gear"></i>
          </button>
          </Teleport>
          <input
            ref="uploadInputRef"
            type="file"
            multiple
            style="display:none"
            @change="onUploadFilesSelected"
          />

          <div
            v-if="activePlace !== 'files'"
            class="breadcrumb-search-area breadcrumb-search-area--static fwin-no-drag"
            :class="{ 'breadcrumb-search-area--embedded': !!toolbarTarget }"
          >
            <i class="bi me-1" :class="places.find((p) => p.id === activePlace)?.icon"></i>
            {{ places.find((p) => p.id === activePlace)?.label }}
          </div>
          <div
            v-else
            class="breadcrumb-search-area fwin-no-drag"
            :class="{ 'breadcrumb-search-active': searchMode || fileSearchActive, 'breadcrumb-search-area--embedded': !!toolbarTarget }"
            @click="!searchMode && !fileSearchActive && enterSearchMode()"
          >
            <template v-if="fileSearchActive">
              <i class="bi bi-search path-icon"></i>
              <input
                v-model="fileSearchQuery"
                type="text"
                class="path-input file-search-input"
                placeholder="Search in this folder…"
                @input="onSearchQueryInput"
                @keyup.escape="exitFileSearch"
              />
              <span v-if="fileSearching" class="search-spinner-wrap">
                <span class="spinner-border spinner-border-sm" role="status"></span>
              </span>
            </template>
            <template v-else-if="!searchMode">
              <div
                ref="breadcrumbStripRef"
                class="breadcrumb-strip"
                v-if="breadcrumbSegments.length > 0"
                @wheel="onBreadcrumbWheel"
              >
                <template v-for="(segment, index) in breadcrumbSegments" :key="segment.path">
                  <button
                    class="breadcrumb-chip"
                    :class="{ 'breadcrumb-chip-current': index === breadcrumbSegments.length - 1 }"
                    @click.stop="loadPath(segment.path)"
                  >
                    <i v-if="index === 0" class="bi bi-house me-1"></i>{{ segment.label }}
                  </button>
                  <span v-if="index < breadcrumbSegments.length - 1" class="breadcrumb-sep">/</span>
                </template>
              </div>
            </template>

            <form v-else-if="searchMode" class="path-input-inner" @submit.prevent="submitPath">
              <i class="bi bi-folder2-open path-icon"></i>
              <input
                v-model="pathInput"
                type="text"
                class="path-input"
                placeholder="Enter a path"
                :disabled="isConnecting"
                @blur="exitSearchMode"
                @keyup.escape="exitSearchMode"
              />
            </form>
          </div>
        </div>
      </Teleport>

        <div v-if="activePlace === 'files' && errorMessage" class="alert alert-danger mb-0 mt-3">
          <i class="bi bi-exclamation-octagon me-2"></i>{{ errorMessage }}
        </div>
      </section>

      <template v-if="activePlace === 'files'">
      <div v-if="isConnecting" class="state-card">
        <div class="spinner-border text-warning mb-3" role="status">
          <span class="visually-hidden">Connecting...</span>
        </div>
        <h3 class="h5 mb-2">Connecting to desktop</h3>
        <p class="text-muted mb-0">
          Trying WebRTC first, then falling back to the direct device session.
        </p>
      </div>

      <div v-else class="explorer-grid">
        <section class="browser-card" @contextmenu.prevent="openBackgroundMenu($event)">
          <div v-if="clipboard && currentBrowse?.is_dir && supportedFileProcedures.copy" class="browser-card-header">
            <div class="browser-header-actions">
              <button
                class="paste-btn"
                :disabled="isOperating"
                @click="pasteClipboard"
                :title="`Paste &quot;${clipboard.name}&quot; here`"
              >
                <i class="bi bi-clipboard-check"></i>
                <span>Paste "{{ clipboard.name }}"</span>
              </button>
            </div>
          </div>
          <div v-if="operationError && !actionSheetVisible && !showRenameDialog && !showDeleteDialog" class="alert alert-danger mb-0 mt-2 py-2 px-3">
            <i class="bi bi-exclamation-octagon me-2"></i>{{ operationError }}
            <button type="button" class="btn-close float-end" @click="operationError = ''"></button>
          </div>

          <!-- Search results -->
          <template v-if="fileSearchActive && fileSearchQuery.trim()">
            <div v-if="fileSearching && !visibleSearchResults.length" class="browser-state">
              <div class="spinner-border mb-3" role="status">
                <span class="visually-hidden">Searching…</span>
              </div>
              <p class="mb-0">Searching…</p>
            </div>
            <div
              v-else-if="visibleSearchResults.length > 0"
              ref="entryListRef"
              class="entry-list"
              :class="{ 'grid-view': isGridView }"
            >
              <button
                v-for="entry in visibleSearchResults"
                :key="entry.path"
                class="entry-row"
                :class="{ active: selectedEntry?.path === entry.path }"
                @click="openSearchResult(entry)"
                @mouseenter="hoveredEntry = entry"
                @mouseleave="hoveredEntry = null"
              >
                <div class="entry-main">
                  <span class="entry-icon" :class="{ 'entry-icon--thumb': thumbnailUrls[entry.path] }" :style="thumbnailUrls[entry.path] ? undefined : iconStyleForEntry(entry)">
                    <img v-if="thumbnailUrls[entry.path]" :src="thumbnailUrls[entry.path]" class="entry-thumb" :alt="entry.name" />
                    <i v-else class="bi" :class="iconClassForEntry(entry)"></i>
                  </span>
                  <div class="entry-text">
                    <div class="entry-name">{{ entry.name }}</div>
                    <div class="entry-meta entry-search-path">{{ searchResultParent(entry) }}</div>
                  </div>
                </div>
                <div class="entry-side">
                  <span class="entry-size">{{ entry.is_dir ? 'Folder' : formatSize(entry.size) }}</span>
                </div>
              </button>
            </div>
            <div v-else-if="fileSearchError" class="browser-state">
              <i class="bi bi-exclamation-octagon display-6 mb-3"></i>
              <p class="mb-0">{{ fileSearchError }}</p>
            </div>
            <div v-else-if="fileSearchQuery.trim()" class="browser-state">
              <i class="bi bi-search display-6 mb-3"></i>
              <p class="mb-0">No results for "{{ fileSearchQuery }}"</p>
            </div>
            <div v-else class="browser-state">
              <i class="bi bi-search display-6 mb-3"></i>
              <p class="mb-0 text-muted">Type to search files in this folder</p>
            </div>
          </template>

          <!-- Normal directory / file view -->
          <template v-else>

          <!-- Initial load spinner: only when no content exists yet -->
          <div v-if="isLoading && !currentBrowse" class="browser-state">
            <div class="spinner-border mb-3" role="status">
              <span class="visually-hidden">Loading...</span>
            </div>
            <p class="mb-0">Loading remote path…</p>
          </div>

          <!-- Entry list: stays mounted, dims during in-folder navigation -->
          <div
            v-else-if="currentBrowse && currentBrowse.is_dir && visibleEntries.length > 0"
            ref="entryListRef"
            class="entry-list"
            :class="{ 'entry-list-loading': isLoading, 'grid-view': isGridView }"
            @click.self="selectedEntry = null"
            @contextmenu.self.prevent.stop="openBackgroundMenu($event)"
          >
            <button
              v-for="entry in visibleEntries"
              :key="entry.path"
              class="entry-row"
              :class="{ active: selectedEntry?.path === entry.path }"
              @click="settingsStore.singleClickOpen ? handleEntryPrimaryAction(entry) : (isGridView ? selectEntry(entry) : openEntry(entry))"
              @dblclick="handleEntryPrimaryAction(entry)"
              @contextmenu.prevent.stop="openContextMenuAtCursor(entry, $event)"
              @mouseenter="hoveredEntry = entry"
              @mouseleave="hoveredEntry = null"
            >
              <div class="entry-main">
                <span class="entry-icon" :class="{ 'entry-icon--thumb': thumbnailUrls[entry.path] }" :style="thumbnailUrls[entry.path] ? undefined : iconStyleForEntry(entry)">
                  <img v-if="thumbnailUrls[entry.path]" :src="thumbnailUrls[entry.path]" class="entry-thumb" :alt="entry.name" />
                  <i v-else class="bi" :class="iconClassForEntry(entry)"></i>
                </span>
                <div class="entry-text">
                  <div class="entry-name">{{ entry.name }}</div>
                  <div class="entry-meta">
                    <span>{{ entry.type }}</span>
                  </div>
                </div>
              </div>

              <div class="entry-side">
                <span class="entry-size">{{
                  entry.is_dir ? 'Folder' : formatSize(entry.size)
                }}</span>
                <button
                  v-if="entryHasMenu(entry)"
                  class="menu-btn"
                  @click.stop="openActionSheet(entry, $event)"
                  title="More actions"
                >
                  <i class="bi bi-three-dots-vertical"></i>
                </button>
              </div>
            </button>

            <div v-if="isLoadingMore" class="load-more-indicator">
              <i class="bi bi-arrow-repeat spin"></i> Loading more…
            </div>
          </div>

          <div v-else-if="currentBrowse && currentBrowse.is_dir" class="browser-state">
            <i class="bi bi-folder2-open display-6 mb-3"></i>
            <p class="mb-0">
              {{
                (currentBrowse.entries?.length || 0) > 0
                  ? 'This folder only contains hidden files.'
                  : 'This folder is empty.'
              }}
            </p>
          </div>

          <div v-else-if="currentBrowse" class="browser-state">
            <i class="bi bi-file-earmark-text display-6 mb-3"></i>
            <p class="mb-0">You are viewing file properties.</p>
          </div>

          </template>

        </section>

      </div>
      </template>

      <EmbeddedIndexedFiles
        v-else
        :key="activePlace"
        :realm="realm"
        :category="activePlace"
        :desktop-name="desktopName"
        :scroll-container="explorerShellRef"
        :focused="focused"
        @open-files="onIndexOpenFiles"
        @preview-file="(session, entry, entries) => emit('preview-file', session, entry, entries)"
      />
    </div>

    <div class="selection-status">
      {{ selectionStatus }}
    </div>
  </div>

  <!-- Entry dropdown / right-click context menu -->
  <div v-if="actionSheetVisible && actionSheetEntry && dropdownPos" class="dropdown-backdrop" @click="closeActionSheet">
    <div
      class="entry-dropdown"
      :style="`top: ${dropdownPos.top}px; right: ${dropdownPos.right}px`"
      @click.stop
    >
      <button v-if="actionSheetEntry.is_dir || actionSheetEntry.is_symlink" class="dropdown-item" @click="openEntry(actionSheetEntry); closeActionSheet()">
        <i class="bi" :class="actionSheetEntry.is_dir ? 'bi-folder2-open' : 'bi-box-arrow-up-right'"></i>Open
      </button>
      <template v-if="!actionSheetEntry.is_dir && !actionSheetEntry.is_symlink">
        <button class="dropdown-item" @click="openActionSheetEntry">
          <i class="bi" :class="getFilePreviewType(actionSheetEntry.name) !== 'none' ? 'bi-eye' : 'bi-download'"></i>
          {{ getFilePreviewType(actionSheetEntry.name) !== 'none' ? 'Open' : 'Download' }}
        </button>
        <button
          v-if="getFilePreviewType(actionSheetEntry.name) !== 'none'"
          class="dropdown-item"
          @click="downloadActionSheetEntry"
        >
          <i class="bi bi-download"></i>Download
        </button>
      </template>
      <button v-if="!actionSheetEntry.is_symlink" class="dropdown-item" @click="openActionSheetEntryInTextEditor">
        <i class="bi bi-file-earmark-code"></i>Open with Text Editor
      </button>
      <div
        v-if="supportedFileProcedures.rename || supportedFileProcedures.delete || supportedFileProcedures.copy"
        class="dropdown-divider"
      ></div>
      <button v-if="supportedFileProcedures.rename" class="dropdown-item" @click="startRename">
        <i class="bi bi-pencil"></i>Rename
      </button>
      <button v-if="supportedFileProcedures.copy" class="dropdown-item" @click="copyToClipboard">
        <i class="bi bi-clipboard"></i>Copy
      </button>
      <div
        v-if="supportedFileProcedures.delete && (supportedFileProcedures.rename || supportedFileProcedures.copy)"
        class="dropdown-divider"
      ></div>
      <button
        v-if="supportedFileProcedures.delete"
        class="dropdown-item dropdown-item-danger"
        @click="startDelete"
      >
        <i class="bi bi-trash"></i>Delete
      </button>
      <div class="dropdown-divider"></div>
      <button class="dropdown-item" @click="showPropertiesFromMenu">
        <i class="bi bi-info-circle"></i>Properties
      </button>
    </div>
  </div>

  <!-- Background right-click context menu -->
  <div v-if="backgroundMenuVisible && backgroundMenuPos" class="dropdown-backdrop" @click="closeBackgroundMenu">
    <div
      class="entry-dropdown"
      :style="`top: ${backgroundMenuPos.y}px; left: ${backgroundMenuPos.x}px`"
      @click.stop
    >
      <button
        v-if="clipboard && currentBrowse?.is_dir && supportedFileProcedures.copy"
        class="dropdown-item"
        @click="closeBackgroundMenu(); pasteClipboard()"
      >
        <i class="bi bi-clipboard-check"></i>Paste "{{ clipboard?.name }}"
      </button>
      <div v-if="clipboard && currentBrowse?.is_dir && supportedFileProcedures.copy" class="dropdown-divider"></div>
      <button class="dropdown-item" @click="refreshCurrentPath(); closeBackgroundMenu()">
        <i class="bi bi-arrow-clockwise"></i>Refresh
      </button>
      <button class="dropdown-item" @click="showHiddenFiles = !showHiddenFiles; closeBackgroundMenu()">
        <i class="bi" :class="showHiddenFiles ? 'bi-eye-slash' : 'bi-eye'"></i>
        {{ showHiddenFiles ? 'Hide hidden files' : 'Show hidden files' }}
      </button>
    </div>
  </div>

  <!-- Toolbar settings menu -->
  <div v-if="settingsMenuVisible && settingsMenuPos" class="dropdown-backdrop" @click="closeSettingsMenu">
    <div
      class="entry-dropdown"
      :style="`top: ${settingsMenuPos.y}px; left: ${settingsMenuPos.x}px`"
      @click.stop
    >
      <button class="dropdown-item" @click="showHiddenFiles = !showHiddenFiles; closeSettingsMenu()">
        <i class="bi" :class="showHiddenFiles ? 'bi-eye-slash' : 'bi-eye'"></i>
        {{ showHiddenFiles ? 'Hide hidden files' : 'Show hidden files' }}
      </button>
    </div>
  </div>

  <!-- Properties popup -->
  <div v-if="propertiesModalVisible && propertiesModalEntry" class="fs-overlay dialog-overlay" @click.self="closePropertiesModal">
    <div class="properties-dialog">
      <div class="properties-header">
        <span class="properties-icon" :style="iconStyleForEntry(propertiesModalEntry)">
          <i class="bi" :class="iconClassForEntry(propertiesModalEntry)"></i>
        </span>
        <div class="properties-title-wrap">
          <h4 class="properties-name">{{ propertiesModalEntry.name }}</h4>
          <span class="properties-kind">{{ propertiesModalEntry.is_dir ? 'Folder' : propertiesModalEntry.type }}</span>
        </div>
        <button class="preview-close-btn" @click="closePropertiesModal">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <div class="properties-body">
        <div class="prop-row">
          <span class="prop-label">Location</span>
          <span class="prop-value prop-mono">{{ propertiesModalEntry.path }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Size</span>
          <span class="prop-value">{{ formatSize(propertiesModalEntry.size) }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Modified</span>
          <span class="prop-value">{{ formatDate(propertiesModalEntry.mod_time) }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Permissions</span>
          <span class="prop-value prop-mono">{{ propertiesModalEntry.mode }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Type</span>
          <span class="prop-value">{{ propertiesModalEntry.type || (propertiesModalEntry.is_dir ? 'Directory' : 'File') }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Directory</span>
          <span class="prop-value">{{ propertiesModalEntry.is_dir ? 'Yes' : 'No' }}</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Symlink</span>
          <span class="prop-value">{{ propertiesModalEntry.is_symlink ? 'Yes' : 'No' }}</span>
        </div>
        <div v-if="propertiesModalEntry.link_target" class="prop-row">
          <span class="prop-label">Links to</span>
          <span class="prop-value prop-mono">{{ propertiesModalEntry.link_target }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Rename dialog -->
  <div v-if="showRenameDialog && actionSheetEntry" class="fs-overlay dialog-overlay" @click.self="showRenameDialog = false; operationError = ''">
    <div class="action-dialog">
      <h4 class="dialog-title">Rename</h4>
      <input
        v-model="renameInput"
        type="text"
        class="rename-input"
        placeholder="New name"
        :disabled="isOperating"
        @keyup.enter="confirmRename"
        @keyup.escape="showRenameDialog = false; operationError = ''"
      />
      <p v-if="operationError" class="op-error">{{ operationError }}</p>
      <div class="dialog-actions">
        <button class="dialog-btn" :disabled="isOperating" @click="showRenameDialog = false; operationError = ''">Cancel</button>
        <button class="dialog-btn dialog-btn-primary" :disabled="isOperating || !renameInput.trim()" @click="confirmRename">
          {{ isOperating ? 'Renaming…' : 'Rename' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Delete confirm dialog -->
  <div v-if="showDeleteDialog && actionSheetEntry" class="fs-overlay dialog-overlay" @click.self="showDeleteDialog = false; operationError = ''">
    <div class="action-dialog">
      <h4 class="dialog-title">Delete "{{ actionSheetEntry.name }}"?</h4>
      <p class="dialog-body">This action cannot be undone.</p>
      <p v-if="operationError" class="op-error">{{ operationError }}</p>
      <div class="dialog-actions">
        <button class="dialog-btn" :disabled="isOperating" @click="showDeleteDialog = false; operationError = ''">Cancel</button>
        <button class="dialog-btn dialog-btn-danger" :disabled="isOperating" @click="confirmDelete">
          {{ isOperating ? 'Deleting…' : 'Delete' }}
        </button>
      </div>
    </div>
  </div>

  <Transition name="dl-toast">
    <div v-if="downloadProgress" class="dl-toast">
      <div class="dl-toast-header">
        <i class="bi bi-download dl-toast-icon"></i>
        <span class="dl-toast-title">Downloading</span>
        <button class="dl-toast-cancel" @click="downloadProgress.cancel()" title="Cancel">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <div class="dl-toast-name">{{ downloadProgress.name }}</div>
      <div class="dl-progress-bar-wrap">
        <div
          class="dl-progress-bar"
          :style="{
            width: downloadProgress.total > 0
              ? `${Math.min(100, Math.round(downloadProgress.received / downloadProgress.total * 100))}%`
              : '0%'
          }"
        ></div>
      </div>
      <div class="dl-toast-meta">
        <span>{{ formatSize(downloadProgress.received) }} / {{ downloadProgress.total > 0 ? formatSize(downloadProgress.total) : '…' }}</span>
        <span>{{ downloadProgress.speed > 0 ? `${formatSize(Math.round(downloadProgress.speed))}/s` : '…' }}</span>
      </div>
    </div>
  </Transition>

  <Transition name="dl-toast">
    <div v-if="uploadProgress" class="dl-toast dl-toast--upload">
      <div class="dl-toast-header">
        <i class="bi bi-cloud-upload dl-toast-icon"></i>
        <span class="dl-toast-title">Uploading</span>
        <button class="dl-toast-cancel" @click="uploadProgress.cancel()" title="Cancel">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <div class="dl-toast-name">{{ uploadProgress.name }}</div>
      <div class="dl-progress-bar-wrap">
        <div
          class="dl-progress-bar"
          :style="{
            width: uploadProgress.total > 0
              ? `${Math.min(100, Math.round(uploadProgress.sent / uploadProgress.total * 100))}%`
              : '0%'
          }"
        ></div>
      </div>
      <div class="dl-toast-meta">
        <span>{{ formatSize(uploadProgress.sent) }} / {{ uploadProgress.total > 0 ? formatSize(uploadProgress.total) : '…' }}</span>
        <span>{{ uploadProgress.speed > 0 ? `${formatSize(Math.round(uploadProgress.speed))}/s` : '…' }}</span>
      </div>
    </div>
  </Transition>

</template>

<style scoped>
.embedded-explorer {
  background: transparent;
  padding: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.places-sidebar {
  display: flex;
  gap: 0.2rem;
  flex-shrink: 0;
  padding: 0.5rem;
  overflow-x: auto;
  background: #f8fafc;
  border-right: 1px solid #e2e8f0;
}

.place-btn {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.5rem 0.7rem;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #334155;
  font-family: inherit;
  font-size: 0.9rem;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.place-btn .bi {
  font-size: 1.05rem;
  color: #64748b;
}

.place-btn:hover:not(:disabled) {
  background: #eef2f6;
}

.place-btn--active,
.place-btn--active:hover:not(:disabled) {
  background: #e2e8f0;
  color: #0f172a;
  font-weight: 600;
}

.place-btn--active .bi {
  color: #2563eb;
}

@media (min-width: 768px) {
  .places-sidebar {
    flex-direction: column;
    width: 9rem;
    overflow: visible;
  }
}

/* Phone: a row of equal-width tabs, icon over label, so every place fits
   on screen without scrolling. */
@media (max-width: 767px) {
  .places-sidebar {
    overflow: visible;
    border-right: none;
    border-bottom: 1px solid #e2e8f0;
    padding: 0.35rem;
  }

  .place-btn {
    flex: 1 1 0;
    min-width: 0;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.4rem 0.2rem;
    font-size: 0.72rem;
  }

  .place-btn .bi {
    font-size: 1.2rem;
  }
}

.explorer-shell {
  max-width: none;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.toolbar-card,
.browser-card,
.state-card {
  background: rgba(255, 255, 255, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.5);
  border-radius: 16px;
  box-shadow:
    0 20px 25px -5px rgba(0, 0, 0, 0.05),
    0 10px 10px -5px rgba(0, 0, 0, 0.01);
  backdrop-filter: blur(12px);
}

.toolbar-card {
  padding: 0.4rem 0.6rem;
  margin-bottom: 0.6rem;
}

.path-toolbar {
  display: grid;
  /* Breadcrumb (minmax) shrinks from 260px to 70px; buttons (auto) don't. */
  grid-template-columns: auto auto auto auto auto auto minmax(70px, 260px);
  gap: 0.5rem;
  align-items: center;
  /* Prevents Grid from stretching the auto button columns to fill leftover space. */
  justify-content: start;
}

.tool-btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 7px;
  background: #fff;
  color: #1e293b;
  font-size: 0.95rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  text-decoration: none;
  transition: background 0.13s ease, border-color 0.13s ease;
}

.tool-btn:hover:not(:disabled) {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.tool-btn:disabled {
  opacity: 0.5;
}

.tool-btn--active {
  background: var(--theme-primary, #3b82f6);
  border-color: var(--theme-primary, #3b82f6);
  color: #fff;
}

.breadcrumb-strip {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  overflow-x: auto;
  padding-bottom: 0.1rem;
  min-width: 0;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.breadcrumb-strip::-webkit-scrollbar {
  display: none;
}

.breadcrumb-sep {
  color: #94a3b8;
  font-size: 0.85rem;
  flex-shrink: 0;
  user-select: none;
  padding: 0 0.1rem;
}

.breadcrumb-chip {
  border: 0;
  border-radius: 6px;
  padding: 0.25rem 0.35rem;
  background: transparent;
  color: #475569;
  font-weight: 600;
  font-size: 0.875rem;
  white-space: nowrap;
  text-decoration: none;
}

.breadcrumb-chip:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.breadcrumb-chip-current {
  color: #0f172a;
  font-weight: 700;
  cursor: default;
}

.breadcrumb-chip-current:hover {
  background: transparent;
  color: #0f172a;
}

.breadcrumb-search-area {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 0.85rem;
  border-radius: 10px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  min-height: 34px;
  cursor: pointer;
  overflow: hidden;
  min-width: 0;
}

.breadcrumb-search-area:hover {
  border-color: #cbd5e1;
}

.breadcrumb-search-area--static {
  cursor: default;
  color: #475569;
  font-size: 0.85rem;
  font-weight: 600;
}

.breadcrumb-search-area--static:hover {
  border-color: #e2e8f0;
}

.breadcrumb-search-active {
  cursor: default;
}

/* ── Embedded in a FloatingWindow titlebar (see floatingWindowToolbar.ts) ── */
.toolbar-card--embedded {
  background: none;
  border: none;
  box-shadow: none;
  backdrop-filter: none;
  padding: 0;
  margin-bottom: 0;
  border-radius: 0;
}

/* Back, forward, refresh, then the path takes whatever is left. */
.path-toolbar--mobile {
  grid-template-columns: auto auto auto minmax(0, 1fr);
}

.path-toolbar--embedded {
  gap: 0.4rem;
  width: 100%;
  /* Flex items default to min-width:auto, blocking the minmax() breadcrumb from shrinking. */
  min-width: 0;
}

.breadcrumb-search-area--embedded {
  background: #f1f5f9;
  border-color: transparent;
  min-height: 32px;
  padding: 0 0.75rem;
}

.breadcrumb-search-area--embedded:hover {
  background: #e6ebf1;
  border-color: transparent;
}

.breadcrumb-search-area--embedded.breadcrumb-search-active {
  background: #fff;
  border-color: #e2e8f0;
}

.search-spinner-wrap {
  margin-left: auto;
  flex-shrink: 0;
  color: #94a3b8;
}

.entry-search-path {
  color: #94a3b8;
  font-size: 0.78rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.path-input-inner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
}

.path-icon {
  color: #64748b;
  flex-shrink: 0;
}

.path-input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  color: #21313f;
}

.state-card,
.browser-state {
  min-height: 360px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  flex-direction: column;
  color: #617182;
  padding: 2rem;
}

.explorer-grid {
  display: block;
}

.browser-card {
  padding: 1.25rem;
}

.browser-card-header {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
  margin-bottom: 1rem;
}

.browser-header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.entry-icon--thumb {
  background: #111 !important;
  padding: 0;
  overflow: hidden;
}

.entry-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: inherit;
}

.selection-status {
  position: absolute;
  bottom: 0.75rem;
  right: 0.85rem;
  pointer-events: none;
  font-size: 0.74rem;
  font-weight: 500;
  color: #475569;
  background: rgba(241, 245, 249, 0.92);
  border: 1px solid #e2e8f0;
  padding: 0.2rem 0.6rem;
  border-radius: 6px;
  white-space: nowrap;
  max-width: calc(100% - 1.5rem);
  overflow: hidden;
  text-overflow: ellipsis;
  backdrop-filter: blur(4px);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.selection-status:not(:empty) {
  opacity: 1;
}

.entry-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  overflow: visible;
  padding-right: 0.25rem;
  transition: opacity 0.15s ease;
}

.entry-list-loading {
  opacity: 0.4;
  pointer-events: none;
}

.load-more-indicator {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.85rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #94a3b8;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.entry-row {
  /* iOS: keep the image/link callout from fighting the long-press menu. */
  -webkit-touch-callout: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  width: 100%;
  text-align: left;
  border: 1px solid rgba(113, 130, 149, 0.14);
  border-radius: 18px;
  background: #fff;
  padding: 0.95rem 1rem;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.entry-row:hover,
.entry-row.active {
  border-color: rgba(0, 0, 0, 0.2);
  box-shadow: 0 10px 24px rgba(71, 85, 105, 0.08);
}

/* .active already shows selection — suppress the native focus ring, which
   differs wildly by browser (red in Firefox, black in Chrome). */
.entry-row::-moz-focus-inner {
  border: 0;
}

.entry-row:focus {
  outline: none;
}

.entry-main,
.entry-side {
  display: flex;
  align-items: center;
  gap: 0.9rem;
}

.entry-main {
  flex: 1;
  min-width: 0;
}

.entry-side {
  flex-shrink: 0;
}

.entry-text {
  min-width: 0;
  overflow: hidden;
}

.entry-icon {
  width: 42px;
  height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  background: #f8fafc;
  color: #475569;
  font-size: 1.15rem;
  flex: 0 0 auto;
}

.entry-name {
  color: #21313f;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-meta {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
  color: #778697;
  font-size: 0.85rem;
}

.entry-size {
  color: #4a5c6d;
  font-size: 0.9rem;
  white-space: nowrap;
}


/* ── Mobile (≤ 767px) ── */
@media (max-width: 767px) {
  .toolbar-card {
    padding: 0.75rem;
  }

  .browser-card {
    padding: 1rem;
  }

  .browser-card-header {
    flex-direction: column;
    gap: 0.6rem;
  }

  .browser-header-actions {
    justify-content: flex-start;
    width: 100%;
  }

  .entry-row {
    padding: 0.7rem 0.75rem;
    border-radius: 14px;
  }

  .entry-list {
    gap: 0.5rem;
    max-height: none;
  }

  .entry-icon {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    font-size: 1rem;
  }

  .state-card,
  .browser-state {
    min-height: 200px;
    padding: 1.5rem;
  }
}

/* ── Menu button on entry rows ── */
.menu-btn {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  border: 0;
  background: transparent;
  color: #64748b;
  font-size: 1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s;
}

.menu-btn:hover {
  background: #f1f5f9;
  color: #0f172a;
}

/* ── Paste button ── */
.paste-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.85rem;
  border-radius: 999px;
  border: 0;
  background: #2c2e33;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 700;
  cursor: pointer;
  max-width: 220px;
  transition: background 0.15s;
}

.paste-btn span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.paste-btn:hover:not(:disabled) {
  background: #1a1b1e;
}

.paste-btn:disabled {
  opacity: 0.5;
}

/* ── Full-screen overlay for dialogs ── */
.fs-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 2000;
  display: flex;
  justify-content: center;
  backdrop-filter: blur(3px);
}

.dialog-overlay {
  align-items: center;
  padding: 1.25rem;
}

/* ── Entry dropdown ── */
.dropdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
}

.entry-dropdown {
  position: fixed;
  z-index: 2001;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.07);
  border: 1px solid rgba(0, 0, 0, 0.08);
  min-width: 152px;
  padding: 0.3rem;
  animation: dropdown-pop 0.13s ease;
}

@keyframes dropdown-pop {
  from { transform: scale(0.88) translateY(-4px); opacity: 0; }
  to   { transform: scale(1)    translateY(0);    opacity: 1; }
}

.dropdown-item {
  width: 100%;
  text-align: left;
  padding: 0.6rem 0.75rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #21313f;
  font-size: 0.9rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  transition: background 0.12s;
  cursor: pointer;
}

.dropdown-item:hover {
  background: #f1f5f9;
}

.dropdown-item-danger {
  color: #dc2626;
}

.dropdown-item-danger:hover {
  background: #fef2f2;
}

.dropdown-divider {
  height: 1px;
  background: #e2e8f0;
  margin: 0.2rem 0.5rem;
}

/* ── Dialog (centered modal) ── */
.action-dialog {
  background: #fff;
  border-radius: 20px;
  width: 100%;
  max-width: 420px;
  padding: 1.5rem;
  animation: dialog-pop 0.18s ease;
}

@keyframes dialog-pop {
  from { transform: scale(0.93); opacity: 0; }
  to   { transform: scale(1);    opacity: 1; }
}

.dialog-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: #21313f;
  margin-bottom: 1rem;
  overflow-wrap: anywhere;
}

.dialog-body {
  color: #778697;
  font-size: 0.9rem;
  margin-bottom: 1.25rem;
}

.rename-input {
  width: 100%;
  padding: 0.75rem 1rem;
  border-radius: 12px;
  border: 1.5px solid #e2e8f0;
  font-size: 1rem;
  color: #21313f;
  margin-bottom: 1rem;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.rename-input:focus {
  border-color: #94a3b8;
}

.rename-input:disabled {
  opacity: 0.6;
}

.op-error {
  color: #dc2626;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}

.dialog-actions {
  display: flex;
  gap: 0.6rem;
  justify-content: flex-end;
}

.dialog-btn {
  padding: 0.6rem 1.2rem;
  border: 0;
  border-radius: 10px;
  font-weight: 700;
  font-size: 0.9rem;
  background: #eef3f7;
  color: #475569;
  cursor: pointer;
  transition: background 0.15s;
  min-width: 80px;
}

.dialog-btn:hover:not(:disabled) {
  background: #e2e8f0;
}

.dialog-btn-primary {
  background: #2c2e33;
  color: #fff;
}

.dialog-btn-primary:hover:not(:disabled) {
  background: #1a1b1e;
}

.dialog-btn-danger {
  background: #dc2626;
  color: #fff;
}

.dialog-btn-danger:hover:not(:disabled) {
  background: #b91c1c;
}

.dialog-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── Preview modal ── */
/* Video/audio/image/pdf/text preview now lives entirely in FilePreviewModal.vue;
   .preview-close-btn is kept here since the properties modal reuses it. */
.preview-close-btn {
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 50%;
  background: #f1f5f9;
  color: #64748b;
  font-size: 0.9rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.preview-close-btn:hover {
  background: #e2e8f0;
  color: #0f172a;
}

/* ── Desktop grid view (≥ 768px) ── */
@media (min-width: 768px) {
  .embedded-explorer {
    display: flex;
    flex-direction: row;
    flex: 1;
  }

  .explorer-shell {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    max-width: none;
  }

  .explorer-grid {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .browser-card {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  /* Hide three-dot button on desktop; right-click context menu replaces it */
  .menu-btn {
    display: none;
  }

  .entry-list.grid-view {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
    gap: 0.2rem;
    flex: 1;
    max-height: none;
    align-content: start;
    padding: 0.35rem;
  }

  .entry-list.grid-view .entry-row {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding: 0.8rem 0.4rem 0.7rem;
    gap: 0.5rem;
    border: 1.5px solid transparent;
    border-radius: 10px;
    background: transparent;
    text-align: center;
    width: 100%;
    min-height: unset;
    /* reset hover effects from list view */
    transition: background 0.13s ease, border-color 0.13s ease;
  }

  .entry-list.grid-view .entry-row:hover {
    background: rgba(241, 245, 249, 0.9);
    border-color: rgba(0, 0, 0, 0.07);
    transform: none;
    box-shadow: none;
  }

  .entry-list.grid-view .entry-row.active {
    background: #dbeafe;
    border-color: rgba(59, 130, 246, 0.28);
    transform: none;
    box-shadow: none;
  }

  .entry-list.grid-view .entry-main {
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-width: 0;
  }

  .entry-list.grid-view .entry-icon {
    width: 52px;
    height: 52px;
    font-size: 1.65rem;
    border-radius: 12px;
    flex-shrink: 0;
  }

  .entry-list.grid-view .entry-name {
    font-size: 0.69rem;
    font-weight: 600;
    text-align: center;
    white-space: normal;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-height: 1.35;
    max-width: 100%;
    word-break: break-word;
  }

  .entry-list.grid-view .entry-meta,
  .entry-list.grid-view .entry-side {
    display: none;
  }
}

/* ── Properties popup ── */
.properties-dialog {
  background: #fff;
  border-radius: 20px;
  width: 100%;
  max-width: 460px;
  animation: dialog-pop 0.18s ease;
  overflow: hidden;
}

.properties-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.25rem 1.25rem 1rem;
  border-bottom: 1px solid #f1f5f9;
}

.properties-icon {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1.6rem;
  flex-shrink: 0;
}

.properties-title-wrap {
  flex: 1;
  min-width: 0;
}

.properties-name {
  font-size: 1rem;
  font-weight: 700;
  color: #1a2535;
  margin: 0 0 0.15rem;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.properties-kind {
  font-size: 0.78rem;
  color: #8896a4;
  font-weight: 500;
}

.properties-body {
  padding: 0.6rem 1.25rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.prop-row {
  display: flex;
  gap: 1rem;
  padding: 0.55rem 0.65rem;
  border-radius: 8px;
}

.prop-row:nth-child(odd) {
  background: #f8fafc;
}

.prop-label {
  flex: 0 0 90px;
  color: #7a8fa0;
  font-size: 0.8rem;
  font-weight: 600;
  padding-top: 1px;
}

.prop-value {
  flex: 1;
  color: #1e2f3e;
  font-size: 0.83rem;
  font-weight: 500;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.prop-mono {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.78rem;
}

.dl-toast--upload {
  bottom: calc(1.5rem + 160px + 0.75rem);
}

.dl-toast {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 3000;
  background: #1e2a35;
  color: #e2e8f0;
  border-radius: 16px;
  padding: 1rem 1.1rem 0.9rem;
  width: 300px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.14);
}

.dl-toast-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.45rem;
}

.dl-toast-icon {
  font-size: 0.9rem;
  color: #60a5fa;
  flex-shrink: 0;
}

.dl-toast-title {
  font-size: 0.82rem;
  font-weight: 700;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  flex: 1;
}

.dl-toast-cancel {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: #94a3b8;
  font-size: 0.7rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
}

.dl-toast-cancel:hover {
  background: rgba(248, 113, 113, 0.2);
  color: #f87171;
}

.dl-toast-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: #f1f5f9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 0.65rem;
}

.dl-progress-bar-wrap {
  height: 5px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.dl-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6, #60a5fa);
  border-radius: 999px;
  transition: width 0.2s ease;
}

.dl-toast-meta {
  display: flex;
  justify-content: space-between;
  font-size: 0.78rem;
  color: #64748b;
  font-weight: 500;
}

</style>
