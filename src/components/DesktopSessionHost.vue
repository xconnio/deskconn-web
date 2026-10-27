<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick, markRaw, type Component } from 'vue'
import { type Session } from 'xconn'
import type { FileEntry } from '@/types'
import { requestMachinesPicker } from '@/router/index'
import { openLauncher } from '@/router/navigation'
import type { AppWindow, CloseableWindowInstance } from '@/composables/useWindowManager'

import { useMachinesStore } from '@/stores/machines'
import { useSettingsStore } from '@/stores/settings'
import { useAuthStore } from '@/stores/auth'
import { useSessionCacheStore } from '@/stores/sessionCache'
import { useDesktopSessionsStore } from '@/stores/desktopSessions'
import { useMachinesOverviewStore } from '@/stores/machinesOverview'
import { useWindowsOverviewStore } from '@/stores/windowsOverview'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { useSessionEncryptionStore } from '@/stores/sessionEncryption'
import { decryptPayload } from '@/utils/encryption'
import EmbeddedDesktopFiles from '@/components/EmbeddedDesktopFiles.vue'
import TerminalPanel from '@/components/TerminalPanel.vue'
import ResourceMonitor from '@/components/ResourceMonitor.vue'
import AgentPanel from '@/components/AgentPanel.vue'
import DesktopSettingsPanel from '@/components/DesktopSettingsPanel.vue'
import FilePreviewModal from '@/components/FilePreviewModal.vue'
import TextEditor from '@/components/TextEditor.vue'
import ScreenshotPanel from '@/components/ScreenshotPanel.vue'
import FloatingWindow from '@/components/FloatingWindow.vue'
import AppDock from '@/components/AppDock.vue'
import DownloadToast from '@/components/DownloadToast.vue'
import { deleteWallpaper, loadCachedWallpaper, storeWallpaper } from '@/composables/useWallpaperCache'
import { getFilePreviewType, type FilePreviewType } from '@/utils/fileTypes'
import type { ShellExec } from '@/services/shellStream'
import { downloadFile, type DownloadProgressState } from '@/utils/fileDownload'

// dockElsewhere: an overview page (Machines, Open Windows) is showing this
// realm's dock in App.vue's #overview-dock instead of on the desktop.
const props = defineProps<{ realm: string; active: boolean; dockElsewhere?: boolean }>()

const machinesStore = useMachinesStore()
const settingsStore = useSettingsStore()
const authStore = useAuthStore()
const sessionCacheStore = useSessionCacheStore()
const desktopSessionsStore = useDesktopSessionsStore()
const machinesOverviewStore = useMachinesOverviewStore()
const windowsOverviewStore = useWindowsOverviewStore()
const capabilitiesStore = useCapabilitiesStore()
const encryptionStore = useSessionEncryptionStore()

const desktopName = computed(() => machinesStore.desktops.find((d) => d.realm === props.realm)?.name ?? props.realm)

const {
  windows,
  focusedId,
  openWindow,
  closeWindowSafely,
  registerWindowInstance,
  closeAll,
  focusWindow,
  minimizeWindow,
  restoreWindow,
  toggleMaximize,
  updateBounds,
  updateTitle,
  syncMaximizedBounds,
  fitWindowsToContainer,
} = desktopSessionsStore.getOrCreate(props.realm)

const sessionTitle = computed(() => {
  const focused = windows.value.find((w) => w.id === focusedId.value)
  return focused
    ? `${focused.title} · ${desktopName.value} - Deskconn`
    : `${desktopName.value} - Deskconn`
})

// Only the active realm's instance may write document.title (others stay mounted via v-show).
watch(
  [sessionTitle, () => props.active],
  ([title, active]) => {
    if (active) document.title = title
  },
  { immediate: true },
)

const launcherBodyRef = ref<HTMLElement | null>(null)
const wallpaperUrl = ref<string | null>(null)
let activeWallpaperObjUrl: string | null = null

// Frozen at the last real size — a backgrounded instance is display:none and reads 0.
const lastKnownSize = ref({ width: 0, height: 0 })

function captureContainerSize() {
  const el = launcherBodyRef.value
  if (!el || !el.clientWidth) return
  lastKnownSize.value = { width: el.clientWidth, height: el.clientHeight }
}

const previewTarget = computed(() => machinesOverviewStore.previewTargets[props.realm])

// The slot's own rendered size (not a fixed constant) — it's a grid cell in
// MachinesOverview and varies with column count/viewport, e.g. 2-up on mobile.
const previewTargetSize = ref<{ width: number; height: number } | null>(null)
let previewTargetResizeObserver: ResizeObserver | null = null

watch(
  previewTarget,
  (el) => {
    previewTargetResizeObserver?.disconnect()
    previewTargetResizeObserver = null
    previewTargetSize.value = null
    if (!el || typeof ResizeObserver === 'undefined') return
    previewTargetResizeObserver = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect
      if (width && height) previewTargetSize.value = { width, height }
    })
    previewTargetResizeObserver.observe(el)
  },
  { immediate: true },
)

// Uniform (not stretched) scale, like object-fit:contain — a desktop whose
// aspect ratio doesn't match the card's would otherwise get squashed. The
// leftover space is centered via the translate offset below.
const previewScale = computed(() => {
  const { width, height } = lastKnownSize.value
  const target = previewTargetSize.value
  if (!target || !width || !height) return null
  const scale = Math.min(target.width / width, target.height / height)
  return {
    scale,
    offsetX: (target.width - width * scale) / 2,
    offsetY: (target.height - height * scale) / 2,
    width,
    height,
  }
})

const launcherBodyStyle = computed(() => {
  const style: Record<string, string> = wallpaperUrl.value
    ? { backgroundImage: `url(${wallpaperUrl.value})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : {}
  const scale = previewScale.value
  if (!scale) return style
  return {
    ...style,
    position: 'absolute',
    top: '0',
    left: '0',
    width: `${scale.width}px`,
    height: `${scale.height}px`,
    transform: `translate(${scale.offsetX}px, ${scale.offsetY}px) scale(${scale.scale})`,
    transformOrigin: 'top left',
    pointerEvents: 'none',
  }
})

// Same scale-in-place technique as the machine-level preview above, but per
// window — the teleported content keeps its real pixel size (so nothing
// reflows) and is just visually shrunk to fit AppDock's overview tile. The
// tile's own rendered size is observed rather than assumed, same reasoning
// as previewTargetSize above.
function windowPreviewTarget(windowId: string): HTMLElement | undefined {
  return windowsOverviewStore.previewTargets[windowId]
}

const windowPreviewSizes = ref<Record<string, { width: number; height: number }>>({})
const windowPreviewObservers = new Map<string, ResizeObserver>()

function observeWindowPreviewTarget(windowId: string, el: HTMLElement | null) {
  windowPreviewObservers.get(windowId)?.disconnect()
  windowPreviewObservers.delete(windowId)

  if (el && typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect
      if (width && height) {
        windowPreviewSizes.value = { ...windowPreviewSizes.value, [windowId]: { width, height } }
      }
    })
    observer.observe(el)
    windowPreviewObservers.set(windowId, observer)
  } else if (windowId in windowPreviewSizes.value) {
    const next = { ...windowPreviewSizes.value }
    delete next[windowId]
    windowPreviewSizes.value = next
  }
}

function windowPreviewStyle(win: AppWindow): Record<string, string> {
  const target = windowPreviewSizes.value[win.id]
  if (!target) return { display: 'contents' }
  // Uniform scale (object-fit:contain, not stretch) — a square-ish app
  // window shouldn't get squashed to fill a wide/short card; it's centered
  // in the leftover space instead, same as the machine preview above.
  const scale = Math.min(target.width / win.width, target.height / win.height)
  const offsetX = (target.width - win.width * scale) / 2
  const offsetY = (target.height - win.height * scale) / 2
  return {
    position: 'absolute',
    top: '0',
    left: '0',
    width: `${win.width}px`,
    height: `${win.height}px`,
    transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
    transformOrigin: 'top left',
    pointerEvents: 'none',
  }
}

// AppDock (not this component) owns registering/unregistering each open
// window's overview-tile slot into the store as its grid re-renders — this
// just reacts by (dis)connecting a ResizeObserver for whichever of *this*
// realm's windows currently have one.
watch(
  () => windowsOverviewStore.previewTargets,
  (targets) => {
    const ids = new Set(windows.value.map((w) => w.id))
    for (const id of [...windowPreviewObservers.keys()]) {
      if (!ids.has(id) || !targets[id]) observeWindowPreviewTarget(id, null)
    }
    for (const id of ids) {
      const el = targets[id]
      if (el) observeWindowPreviewTarget(id, el)
    }
  },
  { immediate: true },
)

function applyWallpaperUrl(url: string | null) {
  if (activeWallpaperObjUrl && activeWallpaperObjUrl !== url) URL.revokeObjectURL(activeWallpaperObjUrl)
  activeWallpaperObjUrl = url
  wallpaperUrl.value = url
}

async function fetchWallpaper() {
  if (!settingsStore.useRemoteWallpaper) {
    wallpaperUrl.value = null
    return
  }

  // Show persisted wallpaper immediately without any network call
  const cached = await loadCachedWallpaper(props.realm)
  applyWallpaperUrl(cached?.url ?? null)

  // Own throwaway session, deliberately not the shared/cached one: wallpaper.get can
  // return a multi-MB image that exceeds the transport's single-frame size limit, which
  // kills the whole stream it was sent on. Opened as its own stream on the shared
  // connection, so that failure can only cost the wallpaper, not the desktop session
  // everything else (terminal, files, ping) relies on.
  let session: Session | null = null
  try {
    const shared = await sessionCacheStore.acquire(props.realm)
    if (!shared) return
    session = await authStore.openSession(props.realm, shared)
    if (!session) return
    const s = session

    // remotecontrol-app serves the wallpaper, with its own key exchange, while its screen
    // app is registered. Older machines serve it from deskconnd.
    if (!capabilitiesStore.byRealm[props.realm]) await capabilitiesStore.fetch(props.realm)
    const keyExchange = capabilitiesStore.isListed(props.realm, 'screen')
      ? capabilitiesStore.keyExchange(props.realm, 'screen')
      : undefined
    const prefix = keyExchange ? 'io.xconn.remotecontrol' : 'io.xconn.deskconn'

    // The desktop keys by caller session, so this session needs its own exchange —
    // going through the realm-keyed shared cache would hand it (and then clobber)
    // the main session's keys, and the calls below would be rejected.
    const keys = await encryptionStore.exchange(s, keyExchange)
    const call = async <T,>(procedure: string): Promise<T> => {
      const encrypted = (await s.call(procedure)).args?.[0] as Uint8Array
      if (!encrypted?.length) throw new Error(`Empty response from ${procedure}`)
      return JSON.parse(new TextDecoder().decode(decryptPayload(encrypted, keys.decryptKey))) as T
    }

    // Cheap checksum check — only download the full image when it has changed. The
    // machine not serving the wallpaper (anymore) drops the cached one.
    let remoteChecksum: string
    let wallpaper: { mime: string; data: string }
    try {
      remoteChecksum = await call<string>(`${prefix}.wallpaper.checksum`)
      if (cached?.checksum === remoteChecksum) return
      wallpaper = await call<{ mime: string; data: string }>(`${prefix}.wallpaper.get`)
    } catch {
      await deleteWallpaper(props.realm)
      applyWallpaperUrl(null)
      return
    }
    if (!wallpaper.data) return
    const data = Uint8Array.from(atob(wallpaper.data), (c) => c.charCodeAt(0))

    const newUrl = await storeWallpaper(props.realm, data, wallpaper.mime, remoteChecksum)
    applyWallpaperUrl(newUrl)
  } catch {
    // silently ignore — wallpaper is optional
  } finally {
    if (session) session.leave().catch(() => {})
  }
}

// The entrance animation plays once, on first show. App.vue hides this host
// with v-show rather than unmounting it, and a CSS animation replays every
// time its element goes from display:none back to shown — so returning to
// the same machine would otherwise look like a fresh load.
const hasEntered = ref(false)

// Blurs the desktop until the backend session is actually up — independent
// of the wallpaper fetch above, which is opt-in via a setting and shouldn't
// gate this.
const isConnecting = ref(true)

// Set whenever there's no live session — the initial connect failed (e.g.
// the machine is offline) or a previously-live session dropped mid-use
// (session.onDisconnect() already fires for that today). Both cases get the
// same full-screen treatment.
const isDisconnected = ref(false)

// From io.xconn.deskconn.device.is_desktop — false on a headless
// machine, which never registers display-only RPCs (screenshot, brightness,
// wallpaper) on the deskconnd side. Defaults true so the icon isn't hidden
// then flashed back in on every ordinary desktop.
const isDesktop = ref(true)

// Apps stay open (blurred) behind the overlay while disconnected — only
// cleared once the user actually navigates away (see the active-prop watch
// below), so returning to a still-active view doesn't lose anything.
function markDisconnected() {
  isDisconnected.value = true
}

// Acquires a session and confirms deskconnd is actually reachable (a WAMP
// session can connect fine even when the machine itself is offline), then
// arms the disconnect listener for the rest of its lifetime.
async function connectSession(): Promise<boolean> {
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) return false
    await session.call('io.xconn.deskconn.ping')

    // Older deskconnd builds don't register this RPC at all — NoSuchProcedure
    // there isn't "not a desktop", it's "unknown", so assume desktop rather
    // than hiding screenshot.
    try {
      const isDesktopResult = await session.call('io.xconn.deskconn.device.is_desktop')
      isDesktop.value = !!isDesktopResult.args?.[0]
    } catch {
      isDesktop.value = true
    }

    await capabilitiesStore.fetch(props.realm)

    session.onDisconnect(async () => {
      markDisconnected()
    })
    return true
  } catch {
    return false
  }
}

// No upfront invalidate here, acquire() reuses a still-healthy cached
// session; a dead one has already evicted itself by this point.
async function connect() {
  isDisconnected.value = false
  isConnecting.value = true
  sessionCacheStore.clearUnreachable(props.realm)

  const connected = await connectSession()
  isConnecting.value = false
  if (!connected) markDisconnected()

  // Otherwise the stale session gets reused next time, stuck on whatever
  // fallback transport it originally connected with.
  if (!connected) {
    sessionCacheStore.invalidate(props.realm)
  }
}

// Other panels (terminal, files, ...) notice a dead desktop the moment their
// own next call fails, well before this session's onDisconnect would — so
// mirror that signal here too instead of leaving the blur to lag behind.
watch(
  () => sessionCacheStore.unreachableRealms.has(props.realm),
  (unreachable) => {
    if (unreachable) markDisconnected()
  },
)

const isMobile = ref(window.innerWidth < 768)
function updateIsMobile() {
  isMobile.value = window.innerWidth < 768
}

// Vertical docks are awkward on narrow screens — always use the bottom dock there.
// Position is per-machine (see stores/settings.ts), set via the in-dock Settings app.
const dockPosition = computed(() => (isMobile.value ? 'bottom' : settingsStore.getDockPosition(props.realm)))

interface AppDef {
  id: string
  label: string
  icon: string
  iconColor: string
  iconBg: string
  width?: number
  height?: number
  /** Floor for interactive resizing — see FloatingWindow's minWidth prop. */
  minWidth?: number
  /** False for apps that only ever appear because a window is already open
   * (see dockApps below) — there's nothing to launch blank. */
  launchable?: boolean
}

const apps: AppDef[] = [
  {
    id: 'files',
    label: 'Files',
    icon: 'bi-folder2-open',
    iconColor: '#ffffff',
    iconBg: '#2563eb',
    // Its titlebar toolbar (6 buttons + breadcrumb/search) can't compress
    // past this without overlapping the minimize/maximize/close controls.
    minWidth: 460,
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: 'bi-terminal',
    iconColor: '#ffffff',
    iconBg: '#1e293b',
    width: 640,
    height: 420,
  },
  {
    id: 'resource-monitor',
    label: 'Resource Monitor',
    icon: 'bi-speedometer',
    iconColor: '#ffffff',
    iconBg: '#0d9488',
    width: 700,
    height: 560,
  },
  {
    id: 'screenshot',
    label: 'Screenshot',
    icon: 'bi-camera',
    iconColor: '#ffffff',
    iconBg: '#4f46e5',
    width: 760,
    height: 560,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'bi-gear',
    iconColor: '#ffffff',
    iconBg: '#475569',
  },
  {
    id: 'text-editor',
    label: 'Text Editor',
    icon: 'bi-text-editor',
    iconColor: '#ffffff',
    iconBg: '#0284c7',
    width: 640,
    height: 420,
    minWidth: 420,
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'bi-robot',
    iconColor: '#ffffff',
    iconBg: '#dc2626',
    width: 820,
    height: 560,
  },
]

// Coding agents, all in the Agents app (see AgentPanel): each is its own app on the machine,
// listed while it's installed. resume is the arguments it resumes a session with.
const AGENTS: Record<string, { label: string; icon: string; accent: string; resume: string[] }> = {
  claude: { label: 'Claude', icon: 'bi-claude', accent: '#d97757', resume: ['--resume'] },
  codex: { label: 'Codex', icon: 'bi-openai', accent: '#10a37f', resume: ['resume'] },
}

const availableAgents = computed(() => Object.entries(AGENTS)
  .filter(([id]) => capabilitiesStore.isListed(props.realm, id))
  .map(([id, a]) => ({ id, label: a.label, icon: a.icon, accent: a.accent })))

// Not pinned in the dock's launcher strip — these only show up (via dockApps
// below) once an image/video is actually open, purely as an instance switcher.
const imageViewerApp: AppDef = {
  id: 'image-viewer',
  label: 'Image Viewer',
  icon: 'bi-image',
  iconColor: '#ffffff',
  iconBg: '#db2777',
  launchable: false,
}

const videoPlayerApp: AppDef = {
  id: 'video-player',
  label: 'Video Player',
  icon: 'bi-collection-play',
  iconColor: '#ffffff',
  iconBg: '#7c3aed',
  launchable: false,
}

const dockApps = computed(() => {
  // Apps the machine's owner/admin turned off (see the Settings app) aren't offered, nor
  // Agents on a machine without any agent installed, which lists none, nor Screenshot
  // while remotecontrol-app (which registers it) isn't running.
  const list = apps.filter((a) => a.id === 'agents'
    ? availableAgents.value.length > 0
    : a.id === 'screenshot'
      ? capabilitiesStore.isListed(props.realm, a.id)
      : capabilitiesStore.isEnabled(props.realm, a.id))
  if (windows.value.some((w) => w.appId === 'image-viewer')) list.push(imageViewerApp)
  if (windows.value.some((w) => w.appId === 'video-player')) list.push(videoPlayerApp)
  return list
})

function launchApp(app: AppDef, initialPath?: string) {
  openWindow({
    appId: app.id,
    title: app.label,
    icon: app.icon,
    iconColor: app.iconColor,
    iconBg: app.iconBg,
    width: app.width,
    height: app.height,
    minWidth: app.minWidth,
    props: initialPath ? { initialPath } : {},
  }, maximizedContainerSize())
}

const appComponents: Record<string, Component> = {
  files: EmbeddedDesktopFiles,
  terminal: TerminalPanel,
  'resource-monitor': ResourceMonitor,
  screenshot: ScreenshotPanel,
  settings: DesktopSettingsPanel,
  preview: FilePreviewModal,
  'image-viewer': FilePreviewModal,
  'video-player': FilePreviewModal,
  'text-editor': TextEditor,
  agents: AgentPanel,
}

function windowProps(win: { id: string; appId: string; props: Record<string, unknown> }) {
  const focused = focusedId.value === win.id
  switch (win.appId) {
    case 'files':
      return {
        realm: props.realm,
        desktopName: desktopName.value,
        initialPath: win.props.initialPath as string | undefined,
        focused,
      }
    case 'terminal':
      return {
        realm: props.realm,
        desktopName: desktopName.value,
        embedded: true,
        exec: win.props.exec as ShellExec | undefined,
        focused,
      }
    case 'agents':
      return {
        realm: props.realm,
        focused,
        agents: availableAgents.value,
      }
    case 'resource-monitor':
      return {
        realm: props.realm,
        desktopName: desktopName.value,
        focused,
      }
    case 'screenshot':
      return {
        realm: props.realm,
        focused,
      }
    case 'settings':
      return {
        realm: props.realm,
        focused,
      }
    case 'preview':
    case 'image-viewer':
    case 'video-player':
      return {
        session: win.props.session as Session,
        realm: props.realm,
        entry: win.props.entry as PreviewEntry,
        entries: win.props.entries as PreviewEntry[],
        focused,
      }
    case 'text-editor':
      return {
        session: win.props.session as Session | undefined,
        realm: props.realm,
        entry: win.props.entry as PreviewEntry | undefined,
        initialFolder: win.props.initialFolder as string | undefined,
        focused,
      }
    default:
      return {
        realm: props.realm,
        category: win.appId,
        desktopName: desktopName.value,
        focused,
      }
  }
}

type PreviewEntry = { path: string; name: string; size: number }

const PREVIEW_STYLE: Record<FilePreviewType, { icon: string; color: string; bg: string }> = {
  image: { icon: imageViewerApp.icon, color: imageViewerApp.iconColor, bg: imageViewerApp.iconBg },
  video: { icon: videoPlayerApp.icon, color: videoPlayerApp.iconColor, bg: videoPlayerApp.iconBg },
  text: { icon: 'bi-text-editor', color: '#ffffff', bg: '#0284c7' },
  audio: { icon: 'bi-file-earmark-music', color: '#ffffff', bg: '#e11d48' },
  pdf: { icon: 'bi-file-earmark-pdf', color: '#ffffff', bg: '#dc2626' },
  none: { icon: 'bi-file-earmark', color: '#ffffff', bg: '#475569' },
}

const downloadProgress = ref<DownloadProgressState | null>(null)

// No previewer for these — skip the blank window and download straight away.
function onPreviewFile(session: Session, entry: PreviewEntry, entries: PreviewEntry[]) {
  const pt = getFilePreviewType(entry.name)
  if (pt === 'none') {
    downloadFile(session, props.realm, entry, downloadProgress)
    return
  }

  const appId = pt === 'image' ? 'image-viewer' : pt === 'video' ? 'video-player' : pt === 'text' ? 'text-editor' : 'preview'
  const style = PREVIEW_STYLE[pt]
  openWindow({
    appId,
    title: entry.name,
    icon: style.icon,
    iconColor: style.color,
    iconBg: style.bg,
    width: 760,
    height: 560,
    props: { session: markRaw(session), entry, entries },
  }, maximizedContainerSize())
}

// Unlike onPreviewFile, this always routes to Text Editor regardless of file
// type, and handles a folder by opening it as the editor's sidebar project
// instead of a single file tab.
function onOpenTextEditor(session: Session, entry: FileEntry) {
  const style = PREVIEW_STYLE.text
  openWindow({
    appId: 'text-editor',
    title: entry.name,
    icon: style.icon,
    iconColor: style.color,
    iconBg: style.bg,
    width: 760,
    height: 560,
    props: entry.is_dir
      ? { session: markRaw(session), initialFolder: entry.path }
      : { session: markRaw(session), entry: { path: entry.path, name: entry.name, size: entry.size } },
  }, maximizedContainerSize())
}

// Opens a terminal resuming agent's session, or starting a new one without a sessionId, in dir.
// The desktop finds the agent as the user's own shell does, on any platform.
function onResumeAgent(agent: string, dir: string, sessionId?: string) {
  const terminalApp = apps.find((a) => a.id === 'terminal')!
  openWindow({
    appId: terminalApp.id,
    title: AGENTS[agent]?.label ?? agent,
    icon: terminalApp.icon,
    iconColor: terminalApp.iconColor,
    iconBg: terminalApp.iconBg,
    width: 760,
    height: 520,
    props: {
      exec: { command: agent, args: sessionId ? [...AGENTS[agent]!.resume, sessionId] : [], dir },
    },
  }, maximizedContainerSize())
}

function onOpenFiles(path: string) {
  const filesApp = apps.find((a) => a.id === 'files')!
  launchApp(filesApp, path)
}

// registerWindowInstance lives on the window manager (not here) so the Open
// Windows page can also close a window safely, without bypassing whatever
// confirmation its live component (e.g. Terminal) wants to run first.
function windowRef(id: string) {
  return (instance: unknown) => {
    registerWindowInstance(id, instance as CloseableWindowInstance | null)
  }
}

const dockThickness = ref(0)

// Where a window minimizes to / opens from. None while the dock is teleported
// onto an overview page — the window isn't on screen then anyway.
function dockIconRect(appId: string) {
  if (props.dockElsewhere) return null
  const icon = launcherBodyRef.value?.querySelector(`.dock [data-dock-app="${CSS.escape(appId)}"] .dock-icon`)
  return icon?.getBoundingClientRect() ?? null
}

function measureDockThickness() {
  // Teleported out of launcherBody — keep the desktop's last measurement.
  if (props.dockElsewhere) return
  const dockEl = launcherBodyRef.value?.querySelector<HTMLElement>('.dock')
  if (!dockEl) {
    dockThickness.value = 0
    return
  }
  dockThickness.value = dockPosition.value === 'bottom' ? dockEl.offsetHeight : dockEl.offsetWidth
}

function maximizedContainerSize() {
  const el = launcherBodyRef.value
  const cw = el?.clientWidth ?? 0
  const ch = el?.clientHeight ?? 0
  switch (dockPosition.value) {
    case 'left':
      return { x: dockThickness.value, y: 0, width: cw - dockThickness.value, height: ch }
    case 'right':
      return { x: 0, y: 0, width: cw - dockThickness.value, height: ch }
    default:
      return { x: 0, y: 0, width: cw, height: ch - dockThickness.value }
  }
}

const insetLeft = computed(() => (dockPosition.value === 'left' ? dockThickness.value : 0))
const insetRight = computed(() => (dockPosition.value === 'right' ? dockThickness.value : 0))
const insetBottom = computed(() => (dockPosition.value === 'bottom' ? dockThickness.value : 0))

function onToggleMaximize(id: string) {
  toggleMaximize(id, maximizedContainerSize())
}

function onActivateWindow(id: string) {
  const win = windows.value.find((w) => w.id === id)
  if (!win) return
  if (win.minimized) {
    restoreWindow(id)
  } else if (focusedId.value === id) {
    minimizeWindow(id)
  } else {
    focusWindow(id)
  }
}

function handleLaunch(appId: string) {
  if (isDisconnected.value) return
  const app = apps.find((a) => a.id === appId)
  if (!app) return
  launchApp(app)
  if (props.dockElsewhere) openLauncher(props.realm)
}

// From an overview page's dock: always show the window, never toggle-minimize it.
function onDockActivate(id: string) {
  if (!props.dockElsewhere) return onActivateWindow(id)
  const win = windows.value.find((w) => w.id === id)
  if (!win) return
  if (win.minimized) restoreWindow(id)
  else focusWindow(id)
  openLauncher(props.realm)
}

// App.vue keeps one DesktopSessionHost per realm mounted forever (v-show, not
// v-if) so navigating to the dashboard and back never remounts this component
// — onMounted's connect() never reruns on its own. Without this, a desktop
// left disconnected just keeps showing the same stale blur/overlay every time
// you come back to it instead of trying again.
watch(() => props.active, (active) => {
  if (active) {
    captureContainerSize()
    syncMaximizedBounds(maximizedContainerSize())
    if (isDisconnected.value && !isConnecting.value) connect()
    return
  }

  // Leaving a disconnected desktop (Dashboard button, browser back, closing
  // the tab) discards its stale windows so the next visit starts fresh —
  // while still connected, navigating away/back is expected to keep them.
  if (isDisconnected.value) closeAll()
})

watch(dockPosition, async () => {
  await nextTick()
  measureDockThickness()
  syncMaximizedBounds(maximizedContainerSize())
})

let launcherBodyResizeObserver: ResizeObserver | null = null

onMounted(() => {
  window.addEventListener('resize', updateIsMobile)
  connect()
  fetchWallpaper()
  measureDockThickness()

  if (launcherBodyRef.value && typeof ResizeObserver !== 'undefined') {
    launcherBodyResizeObserver = new ResizeObserver(() => {
      // A backgrounded instance goes display:none (0 size) — skip rather than
      // scaling every window down to nothing, and leave lastContainer alone
      // so the real resize this masks still computes off the last good size.
      if (!launcherBodyRef.value?.clientWidth) return
      captureContainerSize()
      measureDockThickness()
      const container = maximizedContainerSize()
      syncMaximizedBounds(container)
      fitWindowsToContainer(container)
    })
    launcherBodyResizeObserver.observe(launcherBodyRef.value)
  }
})
onUnmounted(() => {
  window.removeEventListener('resize', updateIsMobile)
  launcherBodyResizeObserver?.disconnect()
  previewTargetResizeObserver?.disconnect()
  for (const observer of windowPreviewObservers.values()) observer.disconnect()
  windowPreviewObservers.clear()
  if (activeWallpaperObjUrl) URL.revokeObjectURL(activeWallpaperObjUrl)
})
</script>

<template>
  <div
    class="launcher-wrapper"
    :class="{ 'fade-in-up': !hasEntered }"
    @animationend.self="hasEntered = true"
    @contextmenu.prevent
  >
    <Teleport :to="previewTarget" :disabled="!previewTarget">
    <div
      ref="launcherBodyRef"
      class="launcher-body"
      :class="{ 'has-wallpaper': !!wallpaperUrl, 'is-connecting': isConnecting, 'is-disconnected': isDisconnected }"
      :style="launcherBodyStyle"
    >
      <div class="windows-layer">
        <FloatingWindow
          v-for="win in windows"
          :key="win.id"
          :title="win.title"
          :icon="win.icon"
          :icon-color="win.iconColor"
          :icon-bg="win.iconBg"
          :x="win.x"
          :y="win.y"
          :width="win.width"
          :height="win.height"
          :min-width="win.minWidth"
          :z-index="win.zIndex"
          :minimized="win.minimized"
          :maximized="win.maximized"
          :focused="focusedId === win.id"
          :mobile="isMobile"
          :use-toolbar-titlebar="win.appId === 'files' || win.appId === 'terminal' || win.appId === 'text-editor'"
          :dark-titlebar="win.appId === 'terminal' || win.appId === 'text-editor' || win.appId === 'agents'"
          :inset-left="insetLeft"
          :inset-right="insetRight"
          :inset-bottom="insetBottom"
          :dock-icon-rect="() => dockIconRect(win.appId)"
          @close="closeWindowSafely(win.id)"
          @focus="focusWindow(win.id)"
          @minimize="minimizeWindow(win.id)"
          @toggle-maximize="onToggleMaximize(win.id)"
          @update:bounds="updateBounds(win.id, $event)"
        >
          <!-- display:contents when not targeted keeps this wrapper out of
               .fwin-body's flex layout entirely, so it's a no-op box until
               the overview actually teleports it (see windowPreviewStyle). -->
          <Teleport :to="windowPreviewTarget(win.id)" :disabled="!windowPreviewTarget(win.id)">
            <div :style="windowPreviewStyle(win)">
              <component
                :is="appComponents[win.appId]"
                :ref="windowRef(win.id)"
                v-bind="windowProps(win)"
                @close="closeWindowSafely(win.id)"
                @open-files="onOpenFiles"
                @preview-file="onPreviewFile"
                @open-text-editor="onOpenTextEditor"
                @resume-agent="onResumeAgent"
                @update-title="updateTitle(win.id, $event)"
              />
            </div>
          </Teleport>
        </FloatingWindow>
      </div>

      <!-- Not shown on an overview page while offline: nothing it could launch. -->
      <Teleport v-if="!(dockElsewhere && isDisconnected)" to="#overview-dock" :disabled="!dockElsewhere" defer>
      <AppDock
        :realm="realm"
        :desktop-name="desktopName"
        :apps="dockApps"
        :windows="windows"
        :focused-id="focusedId"
        :position="dockPosition"
        :offline="isDisconnected"
        :is-desktop="isDesktop"
        :mobile="isMobile"
        @launch="handleLaunch"
        @activate="onDockActivate"
        @close="closeWindowSafely"
      />
      </Teleport>
    </div>
    </Teleport>

    <DownloadToast v-if="downloadProgress" :progress="downloadProgress" />

    <div v-if="isConnecting" class="connecting-overlay">
      <div class="connecting-spinner"></div>
      <p>Connecting to {{ desktopName }}…</p>
    </div>

    <div v-if="isDisconnected" class="disconnected-overlay">
      <i class="bi bi-wifi-off"></i>
      <p>Can't connect to {{ desktopName }}.</p>
      <button type="button" class="overlay-btn" @click="requestMachinesPicker()">Switch Machine</button>
    </div>
  </div>
</template>

<style scoped>
.launcher-wrapper {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.launcher-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background-color: #000;
  /* Default wallpaper, same as the mobile app's; a remote one replaces it via the inline backgroundImage. */
  background-image: linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%);
  transition: filter 0.2s ease;
}

.launcher-body.is-connecting {
  filter: blur(6px);
  pointer-events: none;
}

.launcher-body.is-disconnected {
  filter: grayscale(1) brightness(0.65);
  pointer-events: none;
}

.windows-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
}

.windows-layer :deep(.floating-window) {
  pointer-events: auto;
}

.connecting-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: #334155;
  font-weight: 600;
  pointer-events: none;
}

.connecting-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(51, 65, 85, 0.2);
  border-top-color: #334155;
  border-radius: 50%;
  animation: connecting-spin 0.8s linear infinite;
}

@keyframes connecting-spin {
  to {
    transform: rotate(360deg);
  }
}

.disconnected-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: #f1f5f9;
  font-weight: 600;
  text-align: center;
  padding: 1rem;
}

.disconnected-overlay i {
  font-size: 1.75rem;
}

.overlay-btn {
  margin-top: 0.25rem;
  padding: 0.4rem 1.1rem;
  border: 1px solid rgba(241, 245, 249, 0.4);
  border-radius: 0.4rem;
  background: rgba(15, 23, 42, 0.5);
  color: #f1f5f9;
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
  pointer-events: auto;
}

.overlay-btn:hover {
  background: rgba(15, 23, 42, 0.75);
}
</style>
