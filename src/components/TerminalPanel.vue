<script setup lang="ts">
import { ref, shallowRef, onMounted, onUnmounted, computed, inject, nextTick, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { Session } from 'xconn'
import { useSessionCacheStore } from '@/stores/sessionCache'
import { encryptedCall } from '@/utils/encryptedCall'
import { floatingWindowToolbarKey } from '@/composables/floatingWindowToolbar'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import TabStrip from '@/components/TabStrip.vue'
import { openShell, type ShellHandle } from '@/services/shellStream'
import { isDataChannelClosedError, formatDesktopError } from '@/utils/desktopError'

const props = defineProps<{ realm: string; desktopName: string; embedded?: boolean; focused?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const sessionCacheStore = useSessionCacheStore()

// Absent when there's no FloatingWindow ancestor — the tab bar then renders
// inline instead of teleporting (see floatingWindowToolbar.ts).
const toolbarHostRef = inject(floatingWindowToolbarKey)
const toolbarTarget = computed(() => toolbarHostRef?.value ?? null)
const panelRef = ref<HTMLDivElement | null>(null)
const keybarRef = ref<HTMLDivElement | null>(null)

const enc = new TextEncoder()

interface TabState {
  id: number
  num: number
  label: string
  shellId: string
  term: Terminal | null
  fitAddon: FitAddon | null
  session: Session | null
  conn: ShellHandle | null
  closed: boolean
}

const tabs = shallowRef<TabState[]>([])
const activeTabId = ref(-1)
let nextTabId = 0
const termElMap = new Map<number, HTMLDivElement>()
const stripTabs = computed(() => tabs.value.map((t) => ({ id: t.id, label: t.label })))

const activeTab = computed(() => tabs.value.find(t => t.id === activeTabId.value) ?? null)

let keybarResizeObserver: ResizeObserver | null = null
let panelResizeObserver: ResizeObserver | null = null
let previousBodyOverflow = ''
let previousHtmlOverflow = ''
let previousBodyOverscrollBehavior = ''
let previousHtmlOverscrollBehavior = ''
let touchScrollLastY: number | null = null
let touchStartPoint: { x: number; y: number } | null = null
let longPressTimer: ReturnType<typeof setTimeout> | undefined
// Buffer offsets (inclusive) of the long-pressed word; set while the finger is still down.
let selectAnchor: { start: number; end: number } | null = null
let handleDrag: { which: 'start' | 'end'; dx: number; dy: number } | null = null

// Phones only: tablets, iPads and Chromebooks have touch too but a screen whose short side is >= 600px (Android sw600dp tablet cutoff).
const isMobile = computed(
  () =>
    ('ontouchstart' in window || navigator.maxTouchPoints > 0) &&
    Math.min(window.screen.width, window.screen.height) < 600,
)
const ctrlActive = ref(false)
const panelViewportHeight = ref<number | null>(null)
const keybarHeight = ref(0)
const pressedKeys = ref<string[]>([])
const terminalInsetBottom = computed(() => (isMobile.value ? keybarHeight.value : 0))
const terminalPanelStyle = computed(() =>
  isMobile.value && panelViewportHeight.value !== null
    ? { height: `${panelViewportHeight.value}px` }
    : undefined,
)

function createTabState(): TabState {
  const used = new Set(tabs.value.map(t => t.num))
  let n = 1
  while (used.has(n)) n++
  return {
    id: nextTabId++,
    num: n,
    label: `Terminal ${n}`,
    shellId: '',
    term: null,
    fitAddon: null,
    session: null,
    conn: null,
    closed: false,
  }
}

function registerTermEl(id: number, el: unknown) {
  if (el instanceof HTMLDivElement) {
    termElMap.set(id, el)
  } else {
    termElMap.delete(id)
  }
}

function sendSize(tab: TabState) {
  if (!tab.term || !tab.conn) return
  tab.conn.resize(tab.term.cols, tab.term.rows)
}

function handleResizeTab(tab: TabState) {
  if (!tab.fitAddon) return
  tab.fitAddon.fit()
  sendSize(tab)
}

const handleResize = () => {
  const tab = activeTab.value
  if (tab) handleResizeTab(tab)
}

function handleTerminalInput(tab: TabState, data: string) {
  if (tab.closed || !tab.conn) return

  let input = data
  if (ctrlActive.value && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0) - 64
    input = code > 0 && code < 32 ? String.fromCharCode(code) : data
    ctrlActive.value = false
  }

  tab.conn.send(enc.encode(input))
}

function cleanupTab(tab: TabState) {
  if (tab.closed) return
  // Interrupt any foreground process (top, a stuck command, ...) so it exits
  // promptly on the pty hangup below, instead of leaving it running until
  // the process notices on its own.
  tab.conn?.send(enc.encode('\x03'))
  tab.closed = true
  tab.term?.dispose()
  tab.conn?.close()
  tab.conn = null
  tab.session = null
}

async function startShell(tab: TabState) {
  if (!tab.session || !tab.term) return

  try {
    const conn = await openShell(
      tab.session, props.realm, tab.term.cols, tab.term.rows,
      (bytes) => { if (!tab.closed) tab.term?.write(bytes) },
      () => { if (!tab.closed) closeTab(tab.id) },
    )
    if (tab.closed) { conn.close(); return }
    tab.conn = conn
    tab.shellId = conn.shellId
  } catch (err) {
    if (tab.closed) return
    if (isDataChannelClosedError(err)) sessionCacheStore.reportUnreachable(props.realm)
    tab.term.write(formatDesktopError(err, `Shell error: ${err}`))
  }
}

async function initTab(tab: TabState) {
  const el = termElMap.get(tab.id)
  if (!el) return

  tab.term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    convertEol: true,
    scrollback: 10000,
    fontSize: 14,
    theme: { background: '#1e1e1e' },
  })

  tab.fitAddon = new FitAddon()
  tab.term.loadAddon(tab.fitAddon)
  // Makes http(s) URLs clickable; they open in a new browser tab.
  tab.term.loadAddon(new WebLinksAddon())
  tab.term.open(el)
  tab.fitAddon.fit()
  tab.term.focus()

  try {
    tab.session = await sessionCacheStore.acquire(props.realm)
  } catch {
    tab.term.writeln('Connection failed.')
    return
  }

  if (!tab.session) {
    tab.term.writeln('Connection failed.')
    return
  }

  tab.term.onData((data) => handleTerminalInput(tab, data))
  // Ctrl+Shift+C/V for Linux/ChromeOS/Windows (Cmd+C/V on macOS and the
  // right-click menu already work natively through xterm).
  tab.term.attachCustomKeyEventHandler((e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return true
    if (e.code === 'KeyC') {
      e.preventDefault()
      if (e.type === 'keydown') void copySelection()
      return false
    }
    // Returning false lets the browser fire its native paste event, which xterm handles.
    return e.code !== 'KeyV'
  })
  tab.term.onScroll(() => selViewTick.value++)
  tab.term.onSelectionChange(() => {
    if (tab === activeTab.value && !tab.term?.hasSelection()) touchSel.value = null
  })
  tab.term.onTitleChange((title) => {
    if (tab.closed || !title) return
    tab.label = title
    tabs.value = [...tabs.value]
  })

  await startShell(tab)
}

async function addTab() {
  const tab = createTabState()
  tabs.value = [...tabs.value, tab]
  activeTabId.value = tab.id
  // initTab needs the new tab's .terminal-mount div (v-for'd below) to
  // already exist in the DOM before it can open the terminal into it.
  await nextTick()
  await initTab(tab)
}

async function switchTab(id: number) {
  if (activeTabId.value === id) {
    activeTab.value?.term?.focus()
    return
  }
  activeTabId.value = id
  await nextTick()
  const tab = tabs.value.find(t => t.id === id)
  if (tab) {
    tab.fitAddon?.fit()
    tab.term?.focus()
  }
}

function closeTab(id: number) {
  const idx = tabs.value.findIndex(t => t.id === id)
  if (idx === -1) return
  cleanupTab(tabs.value[idx]!)
  const remaining = tabs.value.filter(t => t.id !== id)
  tabs.value = remaining
  if (remaining.length === 0) {
    unlockPageScroll()
    emit('close')
    return
  }
  void switchTab(remaining[Math.min(idx, remaining.length - 1)]!.id)
}

// Mirrors GNOME Terminal: only warn when something other than the shell
// itself owns the pty's foreground (a running command, an ssh session, ...).
async function isTabBusy(tab: TabState): Promise<boolean> {
  if (!tab.session || !tab.shellId) return false
  try {
    return await encryptedCall<boolean>(
      tab.session, props.realm, 'io.xconn.deskconn.deskconnd.shell.isbusy', tab.shellId)
  } catch (err) {
    // Fails open (no warning) rather than blocking the close — but log it,
    // since a stale deskconnd without this RPC fails silently the same way.
    console.warn('shell.isbusy failed, assuming not busy:', err)
    return false
  }
}

// Two ways a busy tab can need confirming: closing that one tab (middle
// click / its own × button), or closing the whole window (FloatingWindow's
// titlebar × — DesktopSessionHost awaits requestClose() before unmounting
// this component, which is what would otherwise kill `top` with no warning).
type PendingClose =
  | { kind: 'tab'; tab: TabState }
  | { kind: 'window'; resolve: (ok: boolean) => void }

const pendingClose = ref<PendingClose | null>(null)
const closeConfirmTitle = computed(() => {
  const p = pendingClose.value
  if (!p) return ''
  return p.kind === 'tab' ? `Close "${p.tab.label}"?` : 'Close this terminal window?'
})

async function requestCloseTab(id: number) {
  const tab = tabs.value.find(t => t.id === id)
  if (!tab) return
  if (await isTabBusy(tab)) {
    pendingClose.value = { kind: 'tab', tab }
    return
  }
  closeTab(id)
}

// Called by DesktopSessionHost before it unmounts this window.
async function requestClose(): Promise<boolean> {
  const busy = await Promise.all(tabs.value.map((t) => isTabBusy(t)))
  if (!busy.some(Boolean)) return true
  return new Promise<boolean>((resolve) => {
    pendingClose.value = { kind: 'window', resolve }
  })
}

defineExpose({ requestClose })

function confirmPendingClose() {
  const p = pendingClose.value
  pendingClose.value = null
  if (!p) return
  if (p.kind === 'tab') closeTab(p.tab.id)
  else p.resolve(true)
}

function cancelPendingClose() {
  const p = pendingClose.value
  pendingClose.value = null
  if (p?.kind === 'window') p.resolve(false)
}

const updateKeybarPosition = () => {
  requestAnimationFrame(() => {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight
    const panelTop = panelRef.value?.getBoundingClientRect().top ?? 0
    panelViewportHeight.value = Math.max(0, viewportHeight - Math.max(panelTop, 0))
    keybarHeight.value = keybarRef.value?.offsetHeight ?? keybarHeight.value
  })
}

const observePanelSize = () => {
  if (!panelRef.value || typeof ResizeObserver === 'undefined') return

  panelResizeObserver?.disconnect()
  panelResizeObserver = new ResizeObserver(() => {
    if (activeTab.value) handleResizeTab(activeTab.value)
  })
  panelResizeObserver.observe(panelRef.value)
}

const observeKeybarHeight = () => {
  keybarHeight.value = keybarRef.value?.offsetHeight ?? 0

  if (!keybarRef.value || typeof ResizeObserver === 'undefined') return

  keybarResizeObserver?.disconnect()
  keybarResizeObserver = new ResizeObserver(() => {
    keybarHeight.value = keybarRef.value?.offsetHeight ?? 0
  })
  keybarResizeObserver.observe(keybarRef.value)
}

const arrowKeys = {
  up: '\x1b[A',
  left: '\x1b[D',
  down: '\x1b[B',
  right: '\x1b[C',
}

const triggerHapticFeedback = () => {
  navigator.vibrate?.(12)
}

const setKeyPressed = (label: string, pressed: boolean) => {
  const next = new Set(pressedKeys.value)
  if (pressed) {
    next.add(label)
  } else {
    next.delete(label)
  }
  pressedKeys.value = [...next]
}

const isKeyPressed = (label: string) => pressedKeys.value.includes(label)

const lockPageScroll = () => {
  previousBodyOverflow = document.body.style.overflow
  previousHtmlOverflow = document.documentElement.style.overflow
  previousBodyOverscrollBehavior = document.body.style.overscrollBehavior
  previousHtmlOverscrollBehavior = document.documentElement.style.overscrollBehavior

  document.body.style.overflow = 'hidden'
  document.documentElement.style.overflow = 'hidden'
  document.body.style.overscrollBehavior = 'none'
  document.documentElement.style.overscrollBehavior = 'none'
}

const unlockPageScroll = () => {
  document.body.style.overflow = previousBodyOverflow
  document.documentElement.style.overflow = previousHtmlOverflow
  document.body.style.overscrollBehavior = previousBodyOverscrollBehavior
  document.documentElement.style.overscrollBehavior = previousHtmlOverscrollBehavior
}

async function copySelection() {
  const text = activeTab.value?.term?.getSelection()
  if (text) await navigator.clipboard.writeText(text)
}

async function pasteClipboard() {
  const term = activeTab.value?.term
  if (!term) return
  const text = await navigator.clipboard.readText().catch(() => '')
  if (text) term.paste(text)
  term.focus()
}

const contextMenu = ref<{ x: number; y: number; canCopy: boolean; touch?: boolean } | null>(null)

// The desktop suppresses the browser's context menu, so offer our own.
function openContextMenu(e: MouseEvent) {
  if ((e as PointerEvent).pointerType === 'touch') {
    // Android/ChromeOS report a long-press as a contextmenu, and may cancel
    // the touch before our own timer fires — so treat it as the long-press.
    const term = activeTab.value?.term
    if (!term) return
    clearTimeout(longPressTimer)
    beginTouchSelection(term, e.clientX, e.clientY)
    showTouchToolbar(term, { x: e.clientX, y: e.clientY })
    // Touch already ended: no touchend will come to reset the anchor.
    if (!touchStartPoint) selectAnchor = null
    return
  }
  contextMenu.value = { x: e.clientX, y: e.clientY, canCopy: !!activeTab.value?.term?.hasSelection() }
}

async function runContextAction(action: () => Promise<void>) {
  const touch = contextMenu.value?.touch
  contextMenu.value = null
  await action()
  if (touch) clearTouchSelection()
  activeTab.value?.term?.focus()
}

function closeContextMenu() {
  if (contextMenu.value?.touch) clearTouchSelection()
  contextMenu.value = null
}

// Linear buffer offset (row * cols + col) of the cell under a viewport point.
function cellOffsetAt(term: Terminal, x: number, y: number) {
  const rect = term.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
  const col = Math.min(term.cols - 1, Math.max(0, Math.floor(((x - rect.left) / rect.width) * term.cols)))
  const row = Math.min(term.rows - 1, Math.max(0, Math.floor(((y - rect.top) / rect.height) * term.rows)))
  return (row + term.buffer.active.viewportY) * term.cols + col
}

// Offsets of the non-blank run around `offset` on its line (Termux-style word pick).
function wordAt(term: Terminal, offset: number) {
  const row = Math.floor(offset / term.cols)
  const line = term.buffer.active.getLine(row)?.translateToString(false) ?? ''
  let start = offset % term.cols
  let end = start
  if (!line[start]?.trim()) return { start: offset, end: offset }
  while (start > 0 && line[start - 1]?.trim()) start--
  while (end < term.cols - 1 && line[end + 1]?.trim()) end++
  return { start: row * term.cols + start, end: row * term.cols + end }
}

// Touch selection as inclusive buffer offsets; drives the drag handles.
const touchSel = ref<{ start: number; end: number } | null>(null)
const selViewTick = ref(0) // bumped on scroll so the handles follow the text

function applyTouchSelection(term: Terminal, a: number, b: number) {
  const start = Math.min(a, b)
  const end = Math.max(a, b)
  touchSel.value = { start, end }
  term.select(start % term.cols, Math.floor(start / term.cols), end - start + 1)
}

function clearTouchSelection() {
  touchSel.value = null
  activeTab.value?.term?.clearSelection()
}

// Viewport box of a buffer cell, or null when it's scrolled out of view.
function cellBox(term: Terminal, offset: number) {
  const rect = term.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
  const w = rect.width / term.cols
  const h = rect.height / term.rows
  const row = Math.floor(offset / term.cols) - term.buffer.active.viewportY
  if (row < 0 || row >= term.rows) return null
  const left = rect.left + (offset % term.cols) * w
  const top = rect.top + row * h
  return { left, top, right: left + w, bottom: top + h }
}

const selHandles = computed(() => {
  void selViewTick.value
  const term = activeTab.value?.term
  const sel = touchSel.value
  if (!term || !sel) return null
  return { start: cellBox(term, sel.start), end: cellBox(term, sel.end) }
})

// Toolbar sits above the selection, or below its handles when there's no room above.
function showTouchToolbar(term: Terminal, fallback: { x: number; y: number }) {
  const sel = touchSel.value
  const a = sel && cellBox(term, sel.start)
  const b = sel && cellBox(term, sel.end)
  const top = a?.top ?? fallback.y - 16
  const bottom = b?.bottom ?? fallback.y + 16
  const x = a?.left ?? fallback.x
  contextMenu.value = {
    x: Math.max(8, Math.min(x - 20, window.innerWidth - 180)),
    y: top - 56 >= 8 ? top - 56 : bottom + 34,
    canCopy: !!sel,
    touch: true,
  }
}

function onHandleDown(which: 'start' | 'end', e: PointerEvent) {
  const term = activeTab.value?.term
  const sel = touchSel.value
  const box = term && sel && cellBox(term, sel[which])
  if (!box) return
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  // Keep the finger's offset from the cell so the text under it stays visible.
  handleDrag = {
    which,
    dx: e.clientX - (box.left + box.right) / 2,
    dy: e.clientY - (box.top + box.bottom) / 2,
  }
  contextMenu.value = null
}

function onHandleMove(e: PointerEvent) {
  const term = activeTab.value?.term
  const sel = touchSel.value
  if (!handleDrag || !term || !sel) return
  const cur = cellOffsetAt(term, e.clientX - handleDrag.dx, e.clientY - handleDrag.dy)
  const fixed = handleDrag.which === 'start' ? sel.end : sel.start
  if (cur !== fixed) handleDrag.which = cur < fixed ? 'start' : 'end'
  applyTouchSelection(term, cur, fixed)
}

function onHandleUp(e: PointerEvent) {
  const term = activeTab.value?.term
  if (!handleDrag || !term) return
  handleDrag = null
  showTouchToolbar(term, { x: e.clientX, y: e.clientY })
}

const clearTerminalTouchScroll = (event?: TouchEvent) => {
  clearTimeout(longPressTimer)
  const term = activeTab.value?.term
  const touch = event?.changedTouches.item(0)
  if (selectAnchor !== null && term && touch) {
    showTouchToolbar(term, { x: touch.clientX, y: touch.clientY })
  } else if (touchStartPoint) {
    // A plain tap (no drag, no long-press) clears any existing selection.
    clearTouchSelection()
  }
  touchScrollLastY = null
  touchStartPoint = null
  selectAnchor = null
}

function beginTouchSelection(term: Terminal, x: number, y: number) {
  if (selectAnchor !== null) return
  const word = wordAt(term, cellOffsetAt(term, x, y))
  selectAnchor = word
  applyTouchSelection(term, word.start, word.end)
  // Nothing under the finger: leave only Paste on offer.
  if (!term.getSelection().trim()) clearTouchSelection()
  triggerHapticFeedback()
}

// Long-press selects the word under the finger; dragging before lifting extends it.
const handleTerminalTouchStart = (event: TouchEvent) => {
  if (event.touches.length !== 1) return
  const touch = event.touches.item(0)
  if (!touch) return
  const { clientX: x, clientY: y } = touch
  touchStartPoint = { x, y }
  touchScrollLastY = y
  selectAnchor = null
  clearTimeout(longPressTimer)
  // Fallback for browsers that send no contextmenu on long-press (iOS Safari).
  longPressTimer = setTimeout(() => {
    const term = activeTab.value?.term
    if (term) beginTouchSelection(term, x, y)
  }, 450)
}

const handleTerminalTouchMove = (event: TouchEvent) => {
  const touch = event.touches.item(0)
  if (event.touches.length !== 1 || !touch) return

  const term = activeTab.value?.term
  if (selectAnchor !== null && term) {
    event.preventDefault()
    event.stopPropagation()
    const cur = cellOffsetAt(term, touch.clientX, touch.clientY)
    applyTouchSelection(term, Math.min(selectAnchor.start, cur), Math.max(selectAnchor.end, cur))
    return
  }
  if (touchStartPoint && Math.hypot(touch.clientX - touchStartPoint.x, touch.clientY - touchStartPoint.y) > 8) {
    clearTimeout(longPressTimer)
    touchStartPoint = null
  }

  if (!isMobile.value || touchScrollLastY === null) return

  const nextY = touch.clientY
  const deltaY = nextY - touchScrollLastY
  if (Math.abs(deltaY) < 4) return

  event.preventDefault()
  activeTab.value?.term?.scrollLines(Math.round(-deltaY / 16))
  touchScrollLastY = nextY
}

const pressMobileKey = (seq: string, label: string) => {
  setKeyPressed(label, true)
  triggerHapticFeedback()
  if (label === 'CTRL') {
    ctrlActive.value = !ctrlActive.value
    return
  }
  const tab = activeTab.value
  if (tab) handleTerminalInput(tab, seq)
  tab?.term?.focus()
}

const releaseMobileKey = (label: string) => {
  setKeyPressed(label, false)
}

function handleTabShortcut(e: KeyboardEvent) {
  if (!e.altKey || e.ctrlKey || e.metaKey) return
  const n = parseInt(e.key, 10)
  if (n >= 1 && n <= 9) {
    const tab = tabs.value[n - 1]
    if (tab) {
      e.preventDefault()
      e.stopPropagation()
      void switchTab(tab.id)
    }
  }
}

onMounted(async () => {
  if (isMobile.value) {
    lockPageScroll()
  }

  window.addEventListener('keydown', handleTabShortcut, true)
  window.addEventListener('resize', handleResize)
  window.visualViewport?.addEventListener('resize', updateKeybarPosition)
  window.visualViewport?.addEventListener('scroll', updateKeybarPosition)
  await nextTick()
  observeKeybarHeight()
  observePanelSize()
  updateKeybarPosition()

  await addTab()
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleTabShortcut, true)
  window.removeEventListener('resize', handleResize)
  window.visualViewport?.removeEventListener('resize', updateKeybarPosition)
  window.visualViewport?.removeEventListener('scroll', updateKeybarPosition)
  keybarResizeObserver?.disconnect()
  keybarResizeObserver = null
  panelResizeObserver?.disconnect()
  panelResizeObserver = null
  clearTerminalTouchScroll()
  unlockPageScroll()
  for (const tab of tabs.value) cleanupTab(tab)
})

watch([terminalInsetBottom, panelViewportHeight], () => {
  requestAnimationFrame(() => {
    handleResize()
  })
})

// Window focus doesn't move DOM focus, so refocus xterm ourselves.
watch(() => props.focused, (focused) => {
  if (focused) activeTab.value?.term?.focus()
}, { flush: 'post' })
</script>

<template>
  <div ref="panelRef" class="terminal-panel" :style="terminalPanelStyle">
    <Teleport :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
      <TabStrip
        class="tab-bar-bleed"
        :tabs="stripTabs"
        :active-id="activeTabId"
        new-tab-title="New terminal"
        @switch="switchTab"
        @close="requestCloseTab"
        @add="addTab"
      />
    </Teleport>

    <div
      v-for="tab in tabs"
      :key="tab.id"
      v-show="tab.id === activeTabId"
      class="terminal-body"
      @touchstart.capture="handleTerminalTouchStart"
      @touchmove.capture="handleTerminalTouchMove"
      @touchend="clearTerminalTouchScroll"
      @touchcancel="clearTerminalTouchScroll"
      @contextmenu.prevent="openContextMenu"
    >
      <div :ref="(el) => registerTermEl(tab.id, el)" class="terminal-mount"></div>
    </div>

    <Teleport to="body">
      <div
        v-if="contextMenu"
        class="ctx-backdrop"
        @pointerdown="closeContextMenu"
        @contextmenu.prevent="closeContextMenu"
      ></div>
      <div
        v-if="selHandles?.start"
        class="sel-handle sel-handle--start"
        :style="{ left: selHandles.start.left - 22 + 'px', top: selHandles.start.bottom + 'px' }"
        @pointerdown.prevent="onHandleDown('start', $event)"
        @pointermove="onHandleMove"
        @pointerup="onHandleUp"
        @pointercancel="onHandleUp"
      ></div>
      <div
        v-if="selHandles?.end"
        class="sel-handle sel-handle--end"
        :style="{ left: selHandles.end.right + 'px', top: selHandles.end.bottom + 'px' }"
        @pointerdown.prevent="onHandleDown('end', $event)"
        @pointermove="onHandleMove"
        @pointerup="onHandleUp"
        @pointercancel="onHandleUp"
      ></div>
      <div
        v-if="contextMenu"
        class="ctx-menu"
        :class="{ 'ctx-menu--touch': contextMenu.touch }"
        :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
        @keydown.esc="closeContextMenu"
      >
        <button class="ctx-item" :disabled="!contextMenu.canCopy" @click="runContextAction(copySelection)">
          <i class="bi bi-clipboard"></i>
          Copy
        </button>
        <button class="ctx-item" @click="runContextAction(pasteClipboard)">
          <i class="bi bi-clipboard-check"></i>
          Paste
        </button>
      </div>
    </Teleport>

    <div
      v-if="isMobile"
      class="terminal-keybar-spacer"
      :style="{ height: terminalInsetBottom + 'px' }"
      aria-hidden="true"
    ></div>
    <div ref="keybarRef" v-if="isMobile" class="mobile-keybar">
      <div class="keybar-grid">
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('ESC') }"
          @pointerdown.prevent="pressMobileKey('\x1b', 'ESC')"
          @pointerup.prevent="releaseMobileKey('ESC')"
          @pointercancel="releaseMobileKey('ESC')"
          @pointerleave="releaseMobileKey('ESC')"
        >ESC</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('TAB') }"
          @pointerdown.prevent="pressMobileKey('\t', 'TAB')"
          @pointerup.prevent="releaseMobileKey('TAB')"
          @pointercancel="releaseMobileKey('TAB')"
          @pointerleave="releaseMobileKey('TAB')"
        >TAB</button>
        <button
          class="mobile-key"
          :class="{ 'ctrl-active': ctrlActive, 'is-pressed': isKeyPressed('CTRL') }"
          @pointerdown.prevent="pressMobileKey('', 'CTRL')"
          @pointerup.prevent="releaseMobileKey('CTRL')"
          @pointercancel="releaseMobileKey('CTRL')"
          @pointerleave="releaseMobileKey('CTRL')"
        >CTRL</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('-') }"
          @pointerdown.prevent="pressMobileKey('-', '-')"
          @pointerup.prevent="releaseMobileKey('-')"
          @pointercancel="releaseMobileKey('-')"
          @pointerleave="releaseMobileKey('-')"
        >-</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('↑') }"
          @pointerdown.prevent="pressMobileKey(arrowKeys.up, '↑')"
          @pointerup.prevent="releaseMobileKey('↑')"
          @pointercancel="releaseMobileKey('↑')"
          @pointerleave="releaseMobileKey('↑')"
        >↑</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('DEL') }"
          @pointerdown.prevent="pressMobileKey('\x1b[3~', 'DEL')"
          @pointerup.prevent="releaseMobileKey('DEL')"
          @pointercancel="releaseMobileKey('DEL')"
          @pointerleave="releaseMobileKey('DEL')"
        >DEL</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('HOME') }"
          @pointerdown.prevent="pressMobileKey('\x1b[H', 'HOME')"
          @pointerup.prevent="releaseMobileKey('HOME')"
          @pointercancel="releaseMobileKey('HOME')"
          @pointerleave="releaseMobileKey('HOME')"
        >HOME</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('END') }"
          @pointerdown.prevent="pressMobileKey('\x1b[F', 'END')"
          @pointerup.prevent="releaseMobileKey('END')"
          @pointercancel="releaseMobileKey('END')"
          @pointerleave="releaseMobileKey('END')"
        >END</button>

        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('^C') }"
          @pointerdown.prevent="pressMobileKey('\x03', '^C')"
          @pointerup.prevent="releaseMobileKey('^C')"
          @pointercancel="releaseMobileKey('^C')"
          @pointerleave="releaseMobileKey('^C')"
        >^C</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('^D') }"
          @pointerdown.prevent="pressMobileKey('\x04', '^D')"
          @pointerup.prevent="releaseMobileKey('^D')"
          @pointercancel="releaseMobileKey('^D')"
          @pointerleave="releaseMobileKey('^D')"
        >^D</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('/') }"
          @pointerdown.prevent="pressMobileKey('/', '/')"
          @pointerup.prevent="releaseMobileKey('/')"
          @pointercancel="releaseMobileKey('/')"
          @pointerleave="releaseMobileKey('/')"
        >/</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('←') }"
          @pointerdown.prevent="pressMobileKey(arrowKeys.left, '←')"
          @pointerup.prevent="releaseMobileKey('←')"
          @pointercancel="releaseMobileKey('←')"
          @pointerleave="releaseMobileKey('←')"
        >←</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('↓') }"
          @pointerdown.prevent="pressMobileKey(arrowKeys.down, '↓')"
          @pointerup.prevent="releaseMobileKey('↓')"
          @pointercancel="releaseMobileKey('↓')"
          @pointerleave="releaseMobileKey('↓')"
        >↓</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('→') }"
          @pointerdown.prevent="pressMobileKey(arrowKeys.right, '→')"
          @pointerup.prevent="releaseMobileKey('→')"
          @pointercancel="releaseMobileKey('→')"
          @pointerleave="releaseMobileKey('→')"
        >→</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('PgUp') }"
          @pointerdown.prevent="pressMobileKey('\x1b[5~', 'PgUp')"
          @pointerup.prevent="releaseMobileKey('PgUp')"
          @pointercancel="releaseMobileKey('PgUp')"
          @pointerleave="releaseMobileKey('PgUp')"
        >PgUp</button>
        <button
          class="mobile-key"
          :class="{ 'is-pressed': isKeyPressed('PgDn') }"
          @pointerdown.prevent="pressMobileKey('\x1b[6~', 'PgDn')"
          @pointerup.prevent="releaseMobileKey('PgDn')"
          @pointercancel="releaseMobileKey('PgDn')"
          @pointerleave="releaseMobileKey('PgDn')"
        >PgDn</button>
      </div>
    </div>

    <ConfirmDialog
      :open="!!pendingClose"
      :title="closeConfirmTitle"
      message="It has a running process. Closing it may end that process."
      confirm-label="Close"
      @confirm="confirmPendingClose"
      @cancel="cancelPendingClose"
    />
  </div>
</template>

<style scoped>
.terminal-panel {
  width: 100%;
  height: 100%;
  background: #1e1e1e;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  min-height: 0;
  overscroll-behavior: contain;
}

/* Terminal only ever renders inside a FloatingWindow, and TabStrip is the
   sole content teleported into its titlebar — bleeds into the titlebar's
   own 0.25rem/0.6rem padding so the 32px-tall tab strip fills it
   edge-to-edge instead of sitting inside it (see TabStrip.vue for why this
   isn't baked into the component itself: TextEditor nests it next to a
   "Files" button and bleeds its own wrapper instead). */
.tab-bar-bleed {
  margin: -0.25rem 0 -0.25rem -0.6rem;
}

.terminal-body {
  flex: 1;
  min-height: 0;
  padding: 4px;
  overflow: hidden;
  background: #1e1e1e;
  overscroll-behavior: contain;
  touch-action: none;
}

.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}

.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(71, 85, 105, 0.14);
  padding: 0.3rem;
  min-width: 160px;
}

.ctx-item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 7px;
  background: none;
  font-family: inherit;
  font-size: 0.84rem;
  font-weight: 500;
  color: #1e293b;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}

.ctx-item:hover:not(:disabled) { background: #f1f5f9; }
.ctx-item:disabled { opacity: 0.45; cursor: default; }
.ctx-item .bi { font-size: 0.95rem; color: #2563eb; }

.sel-handle {
  position: fixed;
  z-index: 10000;
  width: 22px;
  height: 22px;
  background: #3b82f6;
  border-radius: 50%;
  touch-action: none;
}

.sel-handle--start { border-top-right-radius: 0; }
.sel-handle--end { border-top-left-radius: 0; }

.ctx-menu--touch {
  display: flex;
  min-width: 0;
}

.ctx-menu--touch .ctx-item {
  width: auto;
  padding: 0.6rem 0.9rem;
}

.terminal-keybar-spacer {
  flex-shrink: 0;
}

.mobile-keybar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: #252525;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  z-index: 100;
}

.keybar-grid {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 3px;
  padding: 4px 4px 6px;
}

.mobile-key {
  width: 100%;
  min-width: 0;
  min-height: 34px;
  background: #3a3a3a;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-bottom: 2px solid rgba(0, 0, 0, 0.4);
  color: #cbd5e1;
  font-size: 0.65rem;
  font-family: monospace;
  padding: 8px 4px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  text-overflow: ellipsis;
  touch-action: manipulation;
  transition:
    background 0.1s,
    border-color 0.1s,
    border-bottom-color 0.1s,
    box-shadow 0.1s,
    transform 0.1s;
}

.mobile-key.is-pressed,
.mobile-key:active {
  background: #565656;
  border-bottom-color: rgba(0, 0, 0, 0.18);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
  transform: translateY(1px);
}

.mobile-key.ctrl-active {
  background: #1d4ed8;
  border-color: #3b82f6;
  color: #fff;
}

.mobile-key.ctrl-active.is-pressed,
.mobile-key.ctrl-active:active {
  background: #1e40af;
}

.terminal-mount {
  width: 100%;
  height: 100%;
}

.terminal-body :deep(.xterm) {
  height: 100%;
}

.terminal-body :deep(.xterm-viewport) {
  background: #1e1e1e !important;
  overflow-y: auto !important;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
</style>
