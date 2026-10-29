<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted } from 'vue'
import type { Command } from '@/stores/commandPalette'
import { ApplicationError } from 'xconn'
import { useSessionCacheStore } from '@/stores/sessionCache'
import { useCapabilitiesStore } from '@/stores/capabilities'
import { encryptedCall } from '@/utils/encryptedCall'
import {
  floatingWindowActionsKey,
  floatingWindowMenuKey,
} from '@/composables/floatingWindowToolbar'
import { downloadUrl } from '@/utils/download'
import { formatDesktopError, isDesktopOfflineError } from '@/utils/desktopError'

const props = defineProps<{ realm: string; focused?: boolean }>()

const procedureScreenshot = 'io.xconn.remotecontrol.screenshot'

const sessionCacheStore = useSessionCacheStore()
const capabilitiesStore = useCapabilitiesStore()

// Absent when there's no FloatingWindow ancestor — the action buttons then
// render inline instead of teleporting into the window's titlebar/menu.
const actionsHostRef = inject(floatingWindowActionsKey)
const actionsTarget = computed(() => actionsHostRef?.value ?? null)
const menuHostRef = inject(floatingWindowMenuKey)
const menuTarget = computed(() => menuHostRef?.value ?? null)

const imageUrl = ref<string | null>(null)
const loading = ref(true)
const error = ref('')
const disabled = ref(false)

const zoom = ref(1)
const panX = ref(0)
const panY = ref(0)
const dragging = ref(false)
const dragStart = ref({ x: 0, y: 0, px: 0, py: 0 })
const imgAreaRef = ref<HTMLElement | null>(null)
let pinchDist = 0
let pinchZoomStart = 1
let activeObjectUrl: string | null = null

function setImageUrl(url: string | null, objectUrl = false) {
  if (activeObjectUrl && activeObjectUrl !== url) URL.revokeObjectURL(activeObjectUrl)
  activeObjectUrl = objectUrl ? url : null
  imageUrl.value = url
}

function bytesToObjectUrl(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return URL.createObjectURL(new Blob([buffer], { type: 'image/png' }))
}

function screenshotPayloadToUrl(raw: unknown) {
  if (raw instanceof Uint8Array) {
    return {
      url: bytesToObjectUrl(raw),
      objectUrl: true,
    }
  }
  if (Array.isArray(raw) && raw.every((value) => Number.isInteger(value))) {
    return {
      url: bytesToObjectUrl(Uint8Array.from(raw)),
      objectUrl: true,
    }
  }
  if (typeof raw === 'string') {
    return {
      url: raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`,
      objectUrl: false,
    }
  }
  throw new Error(`Unsupported screenshot payload type: ${typeof raw}`)
}

const copied = ref(false)
async function copyCommand() {
  await navigator.clipboard.writeText('desk screenshot enable')
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

const imgTransform = computed(
  () => `scale(${zoom.value}) translate(${panX.value}px, ${panY.value}px)`,
)

function download() {
  if (!imageUrl.value) return
  downloadUrl(imageUrl.value, `screenshot-${Date.now()}.png`)
}

async function capture() {
  loading.value = true
  error.value = ''
  disabled.value = false
  setImageUrl(null)
  zoom.value = 1
  panX.value = 0
  panY.value = 0
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) throw new Error('not connected')
    // remotecontrol-app serves screenshots end-to-end encrypted with its own key
    // exchange. Older machines, without one listed, serve them unencrypted.
    const keyExchange = capabilitiesStore.keyExchange(props.realm, 'screenshot')
    if (keyExchange) {
      const shot = await encryptedCall<{ mime: string; data: string }>(
        session,
        props.realm,
        procedureScreenshot,
        undefined,
        keyExchange,
      )
      setImageUrl(`data:${shot.mime};base64,${shot.data}`, false)
    } else {
      const result = await session.call(procedureScreenshot)
      const payload = screenshotPayloadToUrl(result.args[0])
      setImageUrl(payload.url, payload.objectUrl)
    }
  } catch (e) {
    const detail = e instanceof ApplicationError ? (e.args?.[0] ?? '') : ''
    if (String(detail).includes('screenshot not enabled')) {
      disabled.value = true
    } else {
      if (isDesktopOfflineError(e)) sessionCacheStore.reportUnreachable(props.realm)
      error.value = formatDesktopError(e)
    }
  } finally {
    loading.value = false
  }
}

function clampZoom(z: number) {
  return Math.min(Math.max(z, 0.2), 12)
}

function fitToScreen() {
  zoom.value = 1
  panX.value = 0
  panY.value = 0
}

function applyZoom(newZoom: number, cursorX: number, cursorY: number) {
  const el = imgAreaRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const cx = cursorX - (rect.left + rect.width / 2)
  const cy = cursorY - (rect.top + rect.height / 2)
  const oldZoom = zoom.value
  panX.value += cx * (1 / newZoom - 1 / oldZoom)
  panY.value += cy * (1 / newZoom - 1 / oldZoom)
  zoom.value = newZoom
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  applyZoom(clampZoom(zoom.value * (e.deltaY < 0 ? 1.12 : 1 / 1.12)), e.clientX, e.clientY)
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return
  dragging.value = true
  dragStart.value = { x: e.clientX, y: e.clientY, px: panX.value, py: panY.value }
}

function onMouseMove(e: MouseEvent) {
  if (!dragging.value) return
  panX.value = dragStart.value.px + (e.clientX - dragStart.value.x) / zoom.value
  panY.value = dragStart.value.py + (e.clientY - dragStart.value.y) / zoom.value
}

function onMouseUp() {
  dragging.value = false
}

function onTouchStart(e: TouchEvent) {
  if (e.touches.length === 2) {
    pinchDist = Math.hypot(
      e.touches[0]!.clientX - e.touches[1]!.clientX,
      e.touches[0]!.clientY - e.touches[1]!.clientY,
    )
    pinchZoomStart = zoom.value
  } else if (e.touches.length === 1) {
    dragging.value = true
    dragStart.value = {
      x: e.touches[0]!.clientX,
      y: e.touches[0]!.clientY,
      px: panX.value,
      py: panY.value,
    }
  }
}

function onTouchMove(e: TouchEvent) {
  e.preventDefault()
  if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[0]!.clientX - e.touches[1]!.clientX,
      e.touches[0]!.clientY - e.touches[1]!.clientY,
    )
    zoom.value = clampZoom(pinchZoomStart * (dist / pinchDist))
  } else if (e.touches.length === 1 && dragging.value) {
    panX.value = dragStart.value.px + (e.touches[0]!.clientX - dragStart.value.x) / zoom.value
    panY.value = dragStart.value.py + (e.touches[0]!.clientY - dragStart.value.y) / zoom.value
  }
}

function onTouchEnd() {
  dragging.value = false
}

const commands = computed<Command[]>(() => [
  { id: 'capture', label: 'Take new screenshot', icon: 'bi-camera', keywords: 'capture refresh', run: () => void capture() },
  ...(imageUrl.value ? [
    { id: 'zoom-in', label: 'Zoom in', icon: 'bi-zoom-in', keys: ['+'], run: () => (zoom.value = clampZoom(zoom.value * 1.2)) },
    { id: 'zoom-out', label: 'Zoom out', icon: 'bi-zoom-out', keys: ['-'], run: () => (zoom.value = clampZoom(zoom.value / 1.2)) },
    { id: 'fit', label: 'Fit to screen', icon: 'bi-aspect-ratio', keys: ['0'], run: fitToScreen },
    { id: 'download', label: 'Download screenshot', icon: 'bi-download', run: download },
  ] : []),
].map((c) => ({ group: '', ...c })))

defineExpose({ commands })

// Only act on these while this window is focused — several screenshot
// windows can be open at once, each with its own zoom state.
function onKeyDown(e: KeyboardEvent) {
  if (!props.focused || !imageUrl.value) return
  if (e.key === '+' || e.key === '=') zoom.value = clampZoom(zoom.value * 1.2)
  else if (e.key === '-') zoom.value = clampZoom(zoom.value / 1.2)
  else if (e.key === '0') fitToScreen()
}

onMounted(() => {
  capture()
  window.addEventListener('keydown', onKeyDown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  setImageUrl(null)
})
</script>

<template>
  <div class="screenshot-panel">
    <Teleport :to="menuTarget ?? 'body'" :disabled="!menuTarget">
      <div v-if="imageUrl" class="sc-zoom-group">
        <button class="sc-action-btn" title="Zoom out (-)" @click="zoom = clampZoom(zoom / 1.2)">
          <i class="bi bi-zoom-out"></i>
        </button>
        <span class="sc-zoom-pct">{{ Math.round(zoom * 100) }}%</span>
        <button class="sc-action-btn" title="Zoom in (+)" @click="zoom = clampZoom(zoom * 1.2)">
          <i class="bi bi-zoom-in"></i>
        </button>
        <button class="sc-action-btn" title="Reset (0)" @click="fitToScreen">
          <i class="bi bi-arrow-counterclockwise"></i>
        </button>
      </div>
    </Teleport>

    <Teleport :to="actionsTarget ?? 'body'" :disabled="!actionsTarget">
      <button class="sc-action-btn" title="Retake" :disabled="loading" @click="capture">
        <i class="bi bi-arrow-clockwise"></i>
      </button>
      <button v-if="imageUrl" class="sc-action-btn" title="Download" @click="download">
        <i class="bi bi-download"></i>
      </button>
    </Teleport>

    <!-- Loading -->
    <div v-if="loading" class="sc-state">
      <div class="spinner-border text-secondary" role="status">
        <span class="visually-hidden">Capturing…</span>
      </div>
      <p class="sc-state-label">Capturing screenshot…</p>
    </div>

    <!-- Disabled -->
    <div v-else-if="disabled" class="sc-state">
      <p class="sc-state-text">Screenshots are disabled on this machine.</p>
      <p class="sc-state-sub">Run on the machine to enable:</p>
      <div class="sc-cmd-row">
        <code class="sc-cmd">desk screenshot enable</code>
        <button class="sc-copy-btn" :title="copied ? 'Copied!' : 'Copy'" @click="copyCommand">
          <i class="bi" :class="copied ? 'bi-check-lg' : 'bi-clipboard'"></i>
        </button>
      </div>
      <button class="sc-retry-btn" @click="capture">Retry</button>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="sc-state">
      <i class="bi bi-exclamation-triangle-fill sc-error-icon"></i>
      <p class="sc-state-text">{{ error }}</p>
      <button class="sc-retry-btn" @click="capture">Retry</button>
    </div>

    <!-- Image viewer -->
    <div
      v-else
      ref="imgAreaRef"
      class="sc-image-area"
      :class="{ dragging }"
      @wheel.prevent="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseUp"
      @touchstart.prevent="onTouchStart"
      @touchmove.prevent="onTouchMove"
      @touchend="onTouchEnd"
    >
      <img
        :src="imageUrl ?? undefined"
        class="sc-image"
        :style="{ transform: imgTransform }"
        draggable="false"
        alt="Screenshot"
      />
    </div>
  </div>
</template>

<style scoped>
.screenshot-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: #fff;
}

/* Teleported into the FloatingWindow's titlebar, beside minimize/maximize/close
   (see floatingWindowActionsKey) — sized to match FloatingWindow's own .fwin-btn. */
.sc-action-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid #d9dee4;
  border-radius: 50%;
  background: #f1f5f9;
  color: #64748b;
  font-size: 0.6rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.sc-action-btn:hover {
  background: #e2e8f0;
  color: #111827;
}

.sc-action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Rendered inside the titlebar's "Menu" dropdown (see floatingWindowMenuKey),
   above the built-in "Full screen" item — not the titlebar strip itself. */
.sc-zoom-group {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.3rem;
  width: 100%;
  padding: 0.15rem 0.35rem;
}

.sc-zoom-pct {
  font-size: 0.72rem;
  font-weight: 600;
  color: #94a3b8;
  min-width: 2.4rem;
  text-align: center;
}

/* ── Loading / disabled / error states ── */
.sc-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  padding: 2rem;
  text-align: center;
  color: #617182;
}

.sc-state-label {
  font-size: 0.85rem;
  color: #888;
  margin: 0;
}

.sc-state-text {
  margin: 0;
  font-size: 0.9rem;
  color: #333;
}

.sc-state-sub {
  margin: 0;
  font-size: 0.82rem;
  color: #777;
}

.sc-error-icon {
  font-size: 1.6rem;
  color: #ef4444;
}

.sc-retry-btn {
  margin-top: 0.25rem;
  padding: 0.4rem 1.1rem;
  border: 1.5px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  color: #334155;
  font-weight: 600;
  font-size: 0.82rem;
  cursor: pointer;
  font-family: inherit;
  transition:
    background 0.13s,
    border-color 0.13s;
}

.sc-retry-btn:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

/* ── Command copy row ─────────────────────────── */
.sc-cmd-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  background: #f3f4f6;
  border-radius: 8px;
  padding: 0.45rem 0.5rem 0.45rem 0.9rem;
  border: 1px solid #e5e7eb;
}

.sc-cmd {
  flex: 1;
  font-family: monospace;
  font-size: 0.85rem;
  color: #1d4ed8;
  font-weight: 600;
  user-select: all;
}

.sc-copy-btn {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  background: transparent;
  border: none;
  color: #9ca3af;
  font-size: 0.85rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition:
    background 0.12s,
    color 0.12s;
}

.sc-copy-btn:hover {
  background: #e5e7eb;
  color: #374151;
}

/* ── Image viewer ────────────────────────── */
.sc-image-area {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #0d0d0d;
  cursor: grab;
  user-select: none;
}

.sc-image-area.dragging {
  cursor: grabbing;
}

.sc-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  transform-origin: center center;
  will-change: transform;
  pointer-events: none;
}
</style>
