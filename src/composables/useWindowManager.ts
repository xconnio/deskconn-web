import { ref } from 'vue'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface AppWindow {
  id: string
  appId: string
  title: string
  icon: string
  iconColor: string
  iconBg: string
  x: number
  y: number
  width: number
  height: number
  /** Floor for interactive resizing — apps whose titlebar toolbar can't
   * compress past a certain width (e.g. Files) need a higher floor than the
   * generic default so their buttons don't overlap the window controls. */
  minWidth?: number
  zIndex: number
  minimized: boolean
  maximized: boolean
  prevBounds?: WindowBounds
  props: Record<string, unknown>
}

export interface OpenWindowOptions {
  appId: string
  title: string
  icon: string
  iconColor: string
  iconBg: string
  props?: Record<string, unknown>
  width?: number
  height?: number
  minWidth?: number
}

export interface ContainerRect {
  x: number
  y: number
  width: number
  height: number
}

/** A window as saved to reopen later: its home bounds (see setHome), unmaximized, with
 * the container they were set against, so a smaller browser scales them down. */
export interface SavedWindow {
  appId: string
  title: string
  icon: string
  iconColor: string
  iconBg: string
  minWidth?: number
  minimized: boolean
  maximized: boolean
  bounds: WindowBounds
  container: ContainerRect
  props: Record<string, unknown>
}

const DEFAULT_WIDTH = 720
const DEFAULT_HEIGHT = 480
const CASCADE_STEP = 28
const CASCADE_LIMIT = 8
const EDGE_MARGIN = 24
const WINDOW_GAP = 12
const STACK_DISTANCE = 40
// Mirrors FloatingWindow's own floor — a rescale should never shrink a
// window past what the user could reach by dragging its edge.
const MIN_WIDTH = 280
const MIN_HEIGHT = 200

// A window's bounds as the user actually left them, plus the container size
// they were set against — the reference fitWindowsToContainer scales from,
// so shrinking and then growing the browser back out restores the exact
// original bounds instead of drifting.
interface HomeBounds {
  bounds: WindowBounds
  container: ContainerRect
}

/** Some embedded apps (Terminal) need an async say over whether their window
 * may actually close — e.g. warning before killing a running process — which
 * a synchronous `dirty` flag can't express. They opt in via defineExpose. */
export type CloseConfirm = (title: string, message: string) => Promise<boolean>

export interface CloseableWindowInstance {
  /** Given confirm, asks through it instead of the app's own in-window
   * dialog — for a caller showing the window too small to answer one. */
  requestClose?: (confirm?: CloseConfirm) => Promise<boolean>
}

export function useWindowManager() {
  const windows = ref<AppWindow[]>([])
  const focusedId = ref<string | null>(null)
  let nextZ = 1
  let nextId = 1
  let cascadeIndex = 0
  const homeById = new Map<string, HomeBounds>()
  // Registered by whoever renders the window's live content (DesktopSessionHost)
  // — consulted by closeWindowSafely so any view (the desktop itself, or the
  // Open Windows page) can close a window without bypassing its confirmation.
  const instances = new Map<string, CloseableWindowInstance>()
  // Last container any call here was told about — updateBounds (a plain drag/
  // resize) isn't given one, so it reuses whatever was seen most recently.
  let lastContainer: ContainerRect | null = null

  // Records bounds as the window's new "home" — the size/position a resize
  // should scale from and, once the container is big enough again, snap back
  // to exactly.
  function setHome(win: AppWindow, container?: ContainerRect) {
    lastContainer = container ?? lastContainer
    homeById.set(win.id, {
      bounds: { x: win.x, y: win.y, width: win.width, height: win.height },
      container: lastContainer ?? { x: 0, y: 0, width: win.width, height: win.height },
    })
  }

  function focusWindow(id: string) {
    const win = windows.value.find((w) => w.id === id)
    if (!win) return
    win.zIndex = ++nextZ
    focusedId.value = id
  }

  function refocusTopWindow() {
    let top: AppWindow | null = null
    for (const w of windows.value) {
      if (w.minimized) continue
      if (!top || w.zIndex > top.zIndex) top = w
    }
    focusedId.value = top?.id ?? null
  }

  // Where a width×height window covers the least of the visible windows,
  // trying the container's corners and the spots flush against each window's
  // sides. Zero overlap with a gap is preferred, then the smallest overlap;
  // ties go to the topmost, then leftmost spot. Since every window opened
  // this way counts for the next, a full screen fills its least-covered areas
  // instead of piling new windows onto one spot.
  function placeWindow(width: number, height: number, container: ContainerRect) {
    const others = windows.value.filter((w) => !w.minimized)
    const minX = container.x + EDGE_MARGIN
    const minY = container.y + EDGE_MARGIN
    const maxX = Math.max(minX, container.x + container.width - width)
    const maxY = Math.max(minY, container.y + container.height - height)
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))
    const candidates = (min: number, max: number, size: number, edges: [number, number][]) =>
      [...new Set([min, max, ...edges.flatMap(([start, end]) => [end + WINDOW_GAP, start - size - WINDOW_GAP])]
        .map((v) => clamp(v, min, max)))].sort((a, b) => a - b)
    const xs = candidates(minX, maxX, width, others.map((w) => [w.x, w.x + w.width]))
    const ys = candidates(minY, maxY, height, others.map((w) => [w.y, w.y + w.height]))

    // Overlap area, padded by the gap so a window touching another isn't a 0.
    // Opening almost exactly on top of a window hides it entirely, so that
    // counts as covering all of it.
    const covered = (x: number, y: number) => others.reduce((sum, w) => {
      if (Math.abs(x - w.x) < STACK_DISTANCE && Math.abs(y - w.y) < STACK_DISTANCE) return sum + w.width * w.height
      const dx = Math.min(x + width, w.x + w.width + WINDOW_GAP) - Math.max(x, w.x - WINDOW_GAP)
      const dy = Math.min(y + height, w.y + w.height + WINDOW_GAP) - Math.max(y, w.y - WINDOW_GAP)
      return dx > 0 && dy > 0 ? sum + dx * dy : sum
    }, 0)

    let best = { x: xs[0]!, y: ys[0]!, area: Infinity }
    for (const y of ys) {
      for (const x of xs) {
        const area = covered(x, y)
        if (area < best.area) best = { x, y, area }
        if (area === 0) return best
      }
    }
    return best
  }

  function openWindow(options: OpenWindowOptions, container?: ContainerRect): string {
    const id = `win-${nextId++}`
    const width = options.width ?? DEFAULT_WIDTH
    const height = options.height ?? DEFAULT_HEIGHT

    let x: number
    let y: number
    if (container) {
      ({ x, y } = placeWindow(width, height, container))
    } else {
      // Nothing to place against: cascade.
      const offset = (cascadeIndex % CASCADE_LIMIT) * CASCADE_STEP
      cascadeIndex++
      x = EDGE_MARGIN + offset
      y = EDGE_MARGIN + offset
    }

    const win: AppWindow = {
      id,
      appId: options.appId,
      title: options.title,
      icon: options.icon,
      iconColor: options.iconColor,
      iconBg: options.iconBg,
      x,
      y,
      width,
      height,
      minWidth: options.minWidth,
      zIndex: ++nextZ,
      minimized: false,
      maximized: false,
      props: options.props ?? {},
    }

    windows.value.push(win)
    focusedId.value = id
    setHome(win, container)
    return id
  }

  // Bottom to top, so restoring them in order keeps their stacking.
  function savedWindows(): SavedWindow[] {
    return [...windows.value].sort((a, b) => a.zIndex - b.zIndex).map((win) => {
      const home = homeById.get(win.id)
      const bounds = (win.maximized ? win.prevBounds : home?.bounds)
        ?? { x: win.x, y: win.y, width: win.width, height: win.height }
      return {
        appId: win.appId,
        title: win.title,
        icon: win.icon,
        iconColor: win.iconColor,
        iconBg: win.iconBg,
        minWidth: win.minWidth,
        minimized: win.minimized,
        maximized: win.maximized,
        bounds,
        container: home?.container ?? lastContainer ?? { x: 0, y: 0, width: bounds.width, height: bounds.height },
        props: win.props,
      }
    })
  }

  function restoreWindows(saved: SavedWindow[], container: ContainerRect) {
    for (const s of saved) {
      const win: AppWindow = {
        id: `win-${nextId++}`,
        appId: s.appId,
        title: s.title,
        icon: s.icon,
        iconColor: s.iconColor,
        iconBg: s.iconBg,
        ...s.bounds,
        minWidth: s.minWidth,
        zIndex: ++nextZ,
        minimized: s.minimized,
        maximized: false,
        props: s.props,
      }
      if (s.maximized) {
        win.prevBounds = { ...s.bounds }
        Object.assign(win, { x: container.x, y: container.y, width: container.width, height: container.height })
        win.maximized = true
      }
      windows.value.push(win)
      homeById.set(win.id, { bounds: { ...s.bounds }, container: s.container })
    }
    fitWindowsToContainer(container)
    refocusTopWindow()
  }

  function closeWindow(id: string) {
    windows.value = windows.value.filter((w) => w.id !== id)
    homeById.delete(id)
    instances.delete(id)
    if (focusedId.value === id) refocusTopWindow()
  }

  function registerWindowInstance(id: string, instance: CloseableWindowInstance | null) {
    if (instance) instances.set(id, instance)
    else instances.delete(id)
  }

  async function closeWindowSafely(id: string, confirm?: CloseConfirm) {
    const canClose = await instances.get(id)?.requestClose?.(confirm)
    if (canClose === false) return
    closeWindow(id)
  }

  function closeAll() {
    windows.value = []
    homeById.clear()
    instances.clear()
    focusedId.value = null
  }

  function updateTitle(id: string, title: string) {
    const win = windows.value.find((w) => w.id === id)
    if (!win) return
    win.title = title
  }

  function minimizeWindow(id: string) {
    const win = windows.value.find((w) => w.id === id)
    if (!win) return
    win.minimized = true
    if (focusedId.value === id) refocusTopWindow()
  }

  function restoreWindow(id: string) {
    const win = windows.value.find((w) => w.id === id)
    if (!win) return
    win.minimized = false
    focusWindow(id)
  }

  function toggleMaximize(id: string, container: ContainerRect) {
    const win = windows.value.find((w) => w.id === id)
    if (!win) return
    lastContainer = container

    if (win.maximized) {
      if (win.prevBounds) {
        win.x = win.prevBounds.x
        win.y = win.prevBounds.y
        win.width = win.prevBounds.width
        win.height = win.prevBounds.height
      }
      win.maximized = false
      win.prevBounds = undefined
    } else {
      win.prevBounds = { x: win.x, y: win.y, width: win.width, height: win.height }
      win.x = container.x
      win.y = container.y
      win.width = container.width
      win.height = container.height
      win.maximized = true
    }
    focusWindow(id)
  }

  function updateBounds(id: string, bounds: Partial<WindowBounds>) {
    const win = windows.value.find((w) => w.id === id)
    if (!win) return
    if (win.maximized) return
    Object.assign(win, bounds)
    setHome(win)
  }

  // Keeps maximized windows filling the container when it resizes (e.g. the
  // sidebar collapsing/expanding) — toggleMaximize only sizes them once, at the
  // moment they're maximized.
  function syncMaximizedBounds(container: ContainerRect) {
    for (const win of windows.value) {
      if (!win.maximized) continue
      win.x = container.x
      win.y = container.y
      win.width = container.width
      win.height = container.height
    }
  }

  // Rescales floating (non-maximized) windows against each one's home bounds
  // (see setHome) rather than the previous frame's size — scaling from a
  // fixed reference instead of chaining deltas means shrinking the browser
  // and growing it back out returns windows to exactly where they were,
  // rather than only ever shrinking further. Never scales past 1 — the home
  // size is a ceiling, not a target to grow beyond.
  function fitWindowsToContainer(container: ContainerRect) {
    lastContainer = container

    for (const win of windows.value) {
      if (win.maximized) continue
      const home = homeById.get(win.id)
      if (!home) continue

      const scaleX = Math.min(1, container.width / home.container.width)
      const scaleY = Math.min(1, container.height / home.container.height)
      const width = Math.min(Math.max(home.bounds.width * scaleX, win.minWidth ?? MIN_WIDTH), container.width)
      const height = Math.min(Math.max(home.bounds.height * scaleY, MIN_HEIGHT), container.height)
      const x = container.x + (home.bounds.x - home.container.x) * scaleX
      const y = container.y + (home.bounds.y - home.container.y) * scaleY
      win.width = width
      win.height = height
      win.x = Math.max(container.x, Math.min(x, container.x + container.width - width))
      win.y = Math.max(container.y, Math.min(y, container.y + container.height - height))
    }
  }

  return {
    windows,
    focusedId,
    openWindow,
    closeWindow,
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
    savedWindows,
    restoreWindows,
  }
}
