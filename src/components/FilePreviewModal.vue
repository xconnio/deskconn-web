<script setup lang="ts">
/**
 * File preview, rendered inside its own FloatingWindow (see DesktopSessionHost.vue).
 * Accepts an established session and a file entry. Images/pdf/text are fetched
 * as a single whole-file range read (see services/fileStream.ts). Audio/video
 * play natively via a same-origin URL backed by a Service Worker Range-request
 * proxy (see sw-download.ts), which forwards range reads over the same
 * fileStream.ts protocol — works over either a direct connection or the
 * relay, whichever the session has.
 */
import { ref, computed, inject, onMounted, onUnmounted } from 'vue'
import { type Session } from '@/services/xconn'
import { floatingWindowActionsKey } from '@/composables/floatingWindowToolbar'
import { canStreamRanges, requestRangeStream } from '@/services/fileStream'
import { uploadFileToPath, type UploadProgress } from '@/utils/fileUpload'
import { downloadUrl, downloadBlob } from '@/utils/download'
import { streamFileData, downloadFile, ensureDownloadServiceWorker, type DownloadProgressState } from '@/utils/fileDownload'
import { dirName, joinPath } from '@/utils/filePath'
import {
  type FilePreviewType,
  formatSize,
  getFilePreviewType,
  getMimeType,
} from '@/utils/fileTypes'

type PreviewEntry = { path: string; name: string; size: number }

const MAX_IMG_PDF = 100 * 1024 * 1024

const props = defineProps<{
  session: Session
  realm: string
  entry: PreviewEntry
  entries?: PreviewEntry[]
  focused?: boolean
}>()

const emit = defineEmits<{
  'update-title': [title: string]
  // Not emitted by this component — declared so Vue treats the listeners
  // DesktopSessionHost.vue binds generically to every app window (@close,
  // @open-files, @preview-file, @open-text-editor) as custom events rather
  // than attrs it tries (and, with this component's multi-root template,
  // fails) to inherit.
  close: []
  'open-files': [path: string]
  'preview-file': [session: Session, entry: PreviewEntry, entries: PreviewEntry[]]
  'open-text-editor': [session: Session, entry: PreviewEntry]
  // Saved with the window, so it reopens on the file stepped to.
  'update-props': [props: { entry: PreviewEntry }]
}>()

// Absent when there's no FloatingWindow ancestor — the download button then
// renders inline instead of teleporting into the window's titlebar.
const actionsHostRef = inject(floatingWindowActionsKey)
const actionsTarget = computed(() => actionsHostRef?.value ?? null)

// The file actually being shown — starts at props.entry but moves independently
// as the user steps through sibling images with the arrows/keyboard, without
// tearing down and reopening the window.
const currentEntry = ref<PreviewEntry>(props.entry)

// Left/right navigation only cycles through images (see openPreview callers,
// which pass every sibling in the current folder/view, not just images).
const imageEntries = computed(() => (props.entries ?? []).filter((e) => getFilePreviewType(e.name) === 'image'))
const currentImageIndex = computed(() => imageEntries.value.findIndex((e) => e.path === currentEntry.value.path))
const canGoPrev = computed(() => previewType.value === 'image' && currentImageIndex.value > 0)
const canGoNext = computed(() => previewType.value === 'image' && currentImageIndex.value >= 0 && currentImageIndex.value < imageEntries.value.length - 1)

function goToEntry(target: PreviewEntry) {
  currentEntry.value = target
  emit('update-title', target.name)
  emit('update-props', { entry: target })
  openFile()
}

// Drives which way the preview-image transition slides in from (see template).
const navDirection = ref<'prev' | 'next'>('next')

function goPrev() {
  if (!canGoPrev.value) return
  const target = imageEntries.value[currentImageIndex.value - 1]
  if (!target) return
  navDirection.value = 'prev'
  goToEntry(target)
}

function goNext() {
  if (!canGoNext.value) return
  const target = imageEntries.value[currentImageIndex.value + 1]
  if (!target) return
  navDirection.value = 'next'
  goToEntry(target)
}

// Fullscreen the wrap rather than the <img> so the prev/next buttons and the
// slide transition keep working while fullscreen.
function toggleImageFullscreen(e: MouseEvent) {
  const wrap = (e.currentTarget as HTMLElement).closest('.preview-image-wrap')
  if (document.fullscreenElement) document.exitFullscreen()
  else wrap?.requestFullscreen?.()
}

function handleKeydown(e: KeyboardEvent) {
  if (!props.focused || editMode.value) return
  if (e.key === 'ArrowLeft' && canGoPrev.value) { e.preventDefault(); goPrev() }
  else if (e.key === 'ArrowRight' && canGoNext.value) { e.preventDefault(); goNext() }
}

const previewType          = ref<FilePreviewType>('none')
const previewBlobUrl       = ref('')
// True while navigating to a sibling image and its data is still loading — the
// outgoing image stays on screen instead of the loading state taking over, so
// there's no blank/white flash between images (see openFile).
const imageSwapping        = ref(false)
const previewTextContent   = ref('')
const previewLoading       = ref(false)
const previewError         = ref('')
const previewExpectedBytes = ref(0)
const previewReceivedBytes = ref(0)
const mediaRetryUsed       = ref(false)

const downloadProgress = ref<DownloadProgressState | null>(null)
let mounted = true

async function fetchFileData(entry: PreviewEntry): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  await streamFileData(props.session, props.realm, entry.path, entry.size, (chunk) => {
    chunks.push(chunk)
    total += chunk.length
    previewReceivedBytes.value = total
  })
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length }
  return combined
}

// Rolling cache of decoded image blob URLs, keyed by path — holds only the
// image currently shown plus its immediate prev/next neighbors (see
// preloadImageNeighbors), so Prev/Next resolves instantly instead of
// re-fetching over the wire, without buffering the whole album into memory.
const imageBlobCache = new Map<string, string>()
const imagePreloads = new Map<string, Promise<string | null>>()

async function fetchImageBlobUrl(
  entry: PreviewEntry,
  onProgress?: (received: number, total: number) => void,
): Promise<string | null> {
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    await streamFileData(props.session, props.realm, entry.path, entry.size, (chunk) => {
      chunks.push(chunk)
      total += chunk.length
      onProgress?.(total, entry.size)
    })
    const combined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length }
    return URL.createObjectURL(new Blob([combined], { type: getMimeType(entry.name) }))
  } catch {
    return null
  }
}

// Dedupes concurrent requests for the same path — a neighbor already
// in-flight or cached from an earlier preload resolves immediately.
function loadImageBlobUrl(
  entry: PreviewEntry,
  onProgress?: (received: number, total: number) => void,
): Promise<string | null> {
  const cached = imageBlobCache.get(entry.path)
  if (cached) return Promise.resolve(cached)
  let promise = imagePreloads.get(entry.path)
  if (!promise) {
    promise = fetchImageBlobUrl(entry, onProgress).then((url) => {
      imagePreloads.delete(entry.path)
      if (url) imageBlobCache.set(entry.path, url)
      return url
    })
    imagePreloads.set(entry.path, promise)
  }
  return promise
}

function pruneImageBlobCache(keep: Set<string>) {
  for (const [path, url] of imageBlobCache) {
    if (!keep.has(path)) {
      URL.revokeObjectURL(url)
      imageBlobCache.delete(path)
    }
  }
}

// Fires off (at most) two background fetches — the entries immediately
// before/after the one just shown — so stepping further in either direction
// only ever has to fetch the single new entry at that edge; the other
// neighbor is already cached from the previous step.
function preloadImageNeighbors() {
  const idx = currentImageIndex.value
  if (idx < 0) return
  const keep = new Set([currentEntry.value.path])
  for (const neighbor of [imageEntries.value[idx - 1], imageEntries.value[idx + 1]]) {
    if (!neighbor || neighbor.size > MAX_IMG_PDF) continue
    keep.add(neighbor.path)
    void loadImageBlobUrl(neighbor)
  }
  pruneImageBlobCache(keep)
}

// Bridges range-request messages coming from the stream service worker (see
// sw-download.ts) to the raw file-stream range protocol (fileStream.ts).
// Multiple range requests (e.g. a browser probing both the start and end of an
// MP4 for its moov box) can be in flight concurrently, each tagged with its own
// reqID and served by its own channel/stream.
function startStreamBridge(port: MessagePort, session: Session, realm: string, path: string): () => void {
  const controllers = new Map<number, AbortController>()

  async function handleRangeRequest(reqID: number, offset: number, length: number) {
    const controller = new AbortController()
    controllers.set(reqID, controller)
    try {
      const { stream } = await requestRangeStream(session, realm, path, offset, length, controller.signal)
      const reader = stream.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const buf = value.slice().buffer
        port.postMessage({ type: 'chunk', reqID, chunk: buf }, [buf])
      }
      port.postMessage({ type: 'range-done', reqID })
    } catch (err) {
      if (!controller.signal.aborted) {
        port.postMessage({ type: 'error', reqID, message: err instanceof Error ? err.message : 'Stream failed' })
      }
    } finally {
      controllers.delete(reqID)
    }
  }

  port.onmessage = (event: MessageEvent) => {
    const data = event.data ?? {}
    if (data.type === 'range-request') { void handleRangeRequest(data.reqID, data.offset, data.length); return }
    if (data.type === 'cancel') controllers.get(data.reqID)?.abort()
  }
  port.start()

  return () => {
    for (const controller of controllers.values()) controller.abort()
    port.close()
  }
}

let activeStreamCleanup: (() => void) | null = null

function stopActiveStream() {
  activeStreamCleanup?.()
  activeStreamCleanup = null
}

// Plays audio/video natively via the stream service worker acting as a local
// Range-request proxy backed by fileStream.ts: the <video>/<audio> element
// gets a same-origin URL and the browser's own media engine handles
// buffering and seeking exactly like it would for a regular HTTP video URL.
// Returns false if there's no stream-capable connection to this device.
async function openStreamedMedia(pt: FilePreviewType): Promise<boolean> {
  if (!canStreamRanges(props.session)) return false

  const sw = await ensureDownloadServiceWorker()
  if (!sw) return false

  stopActiveStream()

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const mc = new MessageChannel()
  const stopBridge = startStreamBridge(mc.port1, props.session, props.realm, currentEntry.value.path)
  activeStreamCleanup = () => { stopBridge(); sw.postMessage({ type: 'stream-close', id }) }

  sw.postMessage({ type: 'stream-init', id, size: currentEntry.value.size, mimeType: getMimeType(currentEntry.value.name) }, [mc.port2])

  if (previewBlobUrl.value) { URL.revokeObjectURL(previewBlobUrl.value); previewBlobUrl.value = '' }
  previewType.value = pt
  previewBlobUrl.value = `/_stream/${id}/${encodeURIComponent(currentEntry.value.name)}`
  previewLoading.value = false
  previewError.value = ''
  return true
}

// Images are served entirely from the neighbor-preload cache above: a fresh
// fetch only happens when the target isn't already cached (first open, or a
// jump beyond the preloaded neighbors). Guards against a stale response
// landing after the user has since navigated elsewhere.
async function openImagePreview() {
  stopActiveStream()
  const target = currentEntry.value
  const swapping = previewType.value === 'image' && !!previewBlobUrl.value
  previewType.value = 'image'
  previewLoading.value = !swapping
  imageSwapping.value = swapping
  previewExpectedBytes.value = target.size
  previewReceivedBytes.value = 0
  previewError.value = ''

  const url = await loadImageBlobUrl(target, (received, total) => {
    if (currentEntry.value.path !== target.path) return
    previewReceivedBytes.value = received
    previewExpectedBytes.value = total
  })
  if (!mounted || currentEntry.value.path !== target.path) return

  if (url) {
    previewBlobUrl.value = url
    preloadImageNeighbors()
  } else {
    previewError.value = 'Failed to load file'
  }
  previewLoading.value = false
  imageSwapping.value = false
}

async function openFile(isRetry = false) {
  if (!isRetry) mediaRetryUsed.value = false
  const pt = getFilePreviewType(currentEntry.value.name)

  if (pt === 'none' || (pt === 'text' && currentEntry.value.size > 5 * 1024 * 1024)) {
    await downloadFileToClient(); return
  }
  if ((pt === 'image' || pt === 'pdf') && currentEntry.value.size > MAX_IMG_PDF) {
    await downloadFileToClient(); return
  }
  if (pt === 'image') {
    await openImagePreview()
    return
  }
  if ((pt === 'audio' || pt === 'video') && !isRetry) {
    const streamed = await openStreamedMedia(pt)
    if (streamed) return
    if (previewBlobUrl.value) { URL.revokeObjectURL(previewBlobUrl.value); previewBlobUrl.value = '' }
    previewType.value = pt
    previewLoading.value = false
    previewError.value = 'Live preview requires a direct connection to this device. Use the Download button above.'
    return
  }

  // Full-buffer fallback: pdf/text, and audio/video retried once after a
  // playback error (see handleMediaError).
  stopActiveStream()
  if (previewBlobUrl.value) { URL.revokeObjectURL(previewBlobUrl.value); previewBlobUrl.value = '' }
  previewType.value = pt
  previewLoading.value = true
  imageSwapping.value = false
  previewExpectedBytes.value = currentEntry.value.size
  previewReceivedBytes.value = 0
  previewError.value = ''

  try {
    const data = await fetchFileData(currentEntry.value)
    if (!mounted) return
    if (pt === 'text') {
      previewTextContent.value = new TextDecoder('utf-8', { fatal: false }).decode(data)
    } else {
      const blob = new Blob([data.slice()], { type: getMimeType(currentEntry.value.name) })
      previewBlobUrl.value = URL.createObjectURL(blob)
    }
  } catch (err) {
    if (mounted) previewError.value = err instanceof Error ? err.message : 'Failed to load file'
  } finally {
    if (mounted) previewLoading.value = false
  }
}

function handleMediaError(event: Event) {
  const media = event.target as HTMLMediaElement
  if (!media.error) return
  if (!mediaRetryUsed.value) { mediaRetryUsed.value = true; openFile(true) }
  else previewError.value = 'This file could not be played. Use the Download button above.'
}

function downloadFromPreview() {
  if (previewType.value === 'audio' || previewType.value === 'video') {
    downloadFileToClient(); return
  }
  if (previewBlobUrl.value) {
    downloadUrl(previewBlobUrl.value, currentEntry.value.name)
  } else if (previewTextContent.value) {
    downloadBlob(new Blob([previewTextContent.value], { type: 'text/plain' }), currentEntry.value.name)
  } else {
    downloadFileToClient()
  }
}

async function downloadFileToClient() {
  await downloadFile(props.session, props.realm, currentEntry.value, downloadProgress)
}

// ── Crop & rotate editor ──────────────────────────────────────────────────
// Edits happen entirely client-side against an offscreen canvas; nothing is
// sent to the device until "Save" uploads the result via fileUpload.ts (the
// same wire protocol as `dc push`, see fileupload.go).
type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'

const editMode      = ref(false)
const cropping      = ref(false)
const savingEdit    = ref(false)
const editError     = ref('')
const editImageUrl  = ref('')
const editImgEl     = ref<HTMLImageElement | null>(null)
const editStageEl   = ref<HTMLElement | null>(null)
const displayTick   = ref(0)
const workingWidth  = ref(0)
const workingHeight = ref(0)
const cropRect      = ref<{ x: number; y: number; w: number; h: number } | null>(null)

const showSaveDialog = ref(false)
const saveAsNew      = ref(false)
const saveFileName   = ref('')
const uploadProgress = ref<{ name: string; sent: number; total: number; speed: number; cancel: () => void } | null>(null)

let workingCanvas: HTMLCanvasElement | null = null
let workingMimeType = 'image/png'
let editStageResizeObserver: ResizeObserver | null = null

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image for editing'))
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to export image'))), type)
  })
}

async function refreshEditPreview() {
  if (!workingCanvas) return
  const blob = await canvasToBlob(workingCanvas, workingMimeType)
  if (editImageUrl.value) URL.revokeObjectURL(editImageUrl.value)
  editImageUrl.value = URL.createObjectURL(blob)
  workingWidth.value = workingCanvas.width
  workingHeight.value = workingCanvas.height
}

async function enterEditMode() {
  if (previewType.value !== 'image' || !previewBlobUrl.value || editMode.value) return
  editError.value = ''
  try {
    const img = await loadImageElement(previewBlobUrl.value)
    const mime = getMimeType(currentEntry.value.name)
    workingMimeType = mime.startsWith('image/') ? mime : 'image/png'

    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    workingCanvas = canvas
    cropRect.value = { x: 0, y: 0, w: canvas.width, h: canvas.height }
    cropping.value = false

    await refreshEditPreview()
    editMode.value = true
  } catch (err) {
    editError.value = err instanceof Error ? err.message : 'Failed to start editing'
  }
}

function cancelEdit() {
  if (editImageUrl.value) URL.revokeObjectURL(editImageUrl.value)
  editImageUrl.value = ''
  workingCanvas = null
  cropRect.value = null
  cropping.value = false
  editMode.value = false
  editError.value = ''
}

async function rotate(deg: 90 | -90) {
  if (!workingCanvas) return
  const src = workingCanvas
  const rotated = document.createElement('canvas')
  rotated.width = src.height
  rotated.height = src.width
  const ctx = rotated.getContext('2d')!
  ctx.translate(rotated.width / 2, rotated.height / 2)
  ctx.rotate((deg * Math.PI) / 180)
  ctx.drawImage(src, -src.width / 2, -src.height / 2)
  workingCanvas = rotated
  cropRect.value = { x: 0, y: 0, w: rotated.width, h: rotated.height }
  await refreshEditPreview()
}

function rotateLeft() { rotate(-90) }
function rotateRight() { rotate(90) }

function toggleCropping() {
  if (!workingCanvas) return
  cropping.value = !cropping.value
  if (cropping.value) cropRect.value = { x: 0, y: 0, w: workingCanvas.width, h: workingCanvas.height }
}

async function applyCrop() {
  if (!workingCanvas || !cropRect.value) return
  const { x, y, w, h } = cropRect.value
  if (w < 1 || h < 1) return
  const cropped = document.createElement('canvas')
  cropped.width = Math.round(w)
  cropped.height = Math.round(h)
  cropped.getContext('2d')!.drawImage(workingCanvas, x, y, w, h, 0, 0, cropped.width, cropped.height)
  workingCanvas = cropped
  cropRect.value = { x: 0, y: 0, w: cropped.width, h: cropped.height }
  cropping.value = false
  await refreshEditPreview()
}

function clamp(v: number, min: number, max: number) { return Math.min(Math.max(v, min), max) }

let dragMode: DragMode | null = null
let dragStartX = 0
let dragStartY = 0
let dragStartRect: { x: number; y: number; w: number; h: number } | null = null
let dragScale = 1

function beginDrag(mode: DragMode, e: PointerEvent) {
  if (!cropRect.value || !editImgEl.value) return
  const rect = editImgEl.value.getBoundingClientRect()
  if (rect.width === 0) return
  dragScale = workingWidth.value / rect.width
  dragMode = mode
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragStartRect = { ...cropRect.value }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
}

function onCropBodyPointerDown(e: PointerEvent) { beginDrag('move', e) }
function onHandlePointerDown(corner: DragMode, e: PointerEvent) { beginDrag(corner, e) }

function onDragMove(e: PointerEvent) {
  if (!dragMode || !dragStartRect) return
  const dx = (e.clientX - dragStartX) * dragScale
  const dy = (e.clientY - dragStartY) * dragScale
  const maxW = workingWidth.value
  const maxH = workingHeight.value
  const MIN = 20

  if (dragMode === 'move') {
    const x = clamp(dragStartRect.x + dx, 0, maxW - dragStartRect.w)
    const y = clamp(dragStartRect.y + dy, 0, maxH - dragStartRect.h)
    cropRect.value = { x, y, w: dragStartRect.w, h: dragStartRect.h }
    return
  }

  let left = dragStartRect.x
  let top = dragStartRect.y
  let right = dragStartRect.x + dragStartRect.w
  let bottom = dragStartRect.y + dragStartRect.h

  if (dragMode.includes('w')) left = clamp(dragStartRect.x + dx, 0, right - MIN)
  if (dragMode.includes('e')) right = clamp(right + dx, left + MIN, maxW)
  if (dragMode.includes('n')) top = clamp(dragStartRect.y + dy, 0, bottom - MIN)
  if (dragMode.includes('s')) bottom = clamp(bottom + dy, top + MIN, maxH)

  cropRect.value = { x: left, y: top, w: right - left, h: bottom - top }
}

function onDragEnd() {
  dragMode = null
  dragStartRect = null
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
}

function onEditImageLoad() {
  displayTick.value++
  if (editStageResizeObserver || !editImgEl.value) return
  editStageResizeObserver = new ResizeObserver(() => { displayTick.value++ })
  editStageResizeObserver.observe(editImgEl.value)
}

// Position/size the crop overlay in screen pixels, relative to .preview-image-wrap
// (editStageEl) — the image itself may be inset within it, so the overlay's
// origin is the image's rect offset from the wrap's rect, not (0, 0).
const cropBoxStyle = computed(() => {
  void displayTick.value // track for recompute on load/resize
  if (!cropRect.value || !editImgEl.value || !editStageEl.value || !workingWidth.value) return {}
  const imgRect = editImgEl.value.getBoundingClientRect()
  const wrapRect = editStageEl.value.getBoundingClientRect()
  const scale = imgRect.width / workingWidth.value
  const offsetX = imgRect.left - wrapRect.left
  const offsetY = imgRect.top - wrapRect.top
  return {
    left: `${offsetX + cropRect.value.x * scale}px`,
    top: `${offsetY + cropRect.value.y * scale}px`,
    width: `${cropRect.value.w * scale}px`,
    height: `${cropRect.value.h * scale}px`,
  }
})

function suggestNewFileName(original: string): string {
  const dot = original.lastIndexOf('.')
  if (dot <= 0) return `${original}-edited`
  return `${original.slice(0, dot)}-edited${original.slice(dot)}`
}

function openSaveDialog() {
  if (!workingCanvas) return
  saveAsNew.value = false
  saveFileName.value = suggestNewFileName(currentEntry.value.name)
  editError.value = ''
  showSaveDialog.value = true
}

async function confirmSave() {
  if (!workingCanvas) return
  const targetName = saveAsNew.value ? saveFileName.value.trim() : currentEntry.value.name
  if (!targetName) { editError.value = 'Enter a file name'; return }

  const destDir = dirName(currentEntry.value.path)
  const destPath = joinPath(destDir, targetName)

  editError.value = ''
  savingEdit.value = true

  try {
    const blob = await canvasToBlob(workingCanvas, workingMimeType)
    const controller = new AbortController()
    uploadProgress.value = { name: targetName, sent: 0, total: blob.size, speed: 0, cancel: () => controller.abort() }

    await uploadFileToPath(props.session, props.realm, destDir, targetName, blob, (p: UploadProgress) => {
      if (!uploadProgress.value) return
      uploadProgress.value.sent = p.sent
      uploadProgress.value.total = p.total
      uploadProgress.value.speed = p.speed
    }, controller.signal)

    showSaveDialog.value = false
    const finalPath = saveAsNew.value ? destPath : currentEntry.value.path
    cancelEdit()
    goToEntry({ path: finalPath, name: targetName, size: blob.size })
  } catch (err) {
    editError.value = err instanceof Error ? err.message : 'Failed to save image'
  } finally {
    savingEdit.value = false
    uploadProgress.value = null
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
  openFile()
})

onUnmounted(() => {
  mounted = false
  document.removeEventListener('keydown', handleKeydown)
  // previewBlobUrl for an image points into imageBlobCache (revoked below) —
  // only a non-image preview (pdf/text/audio-video-retry) owns its URL directly.
  if (previewBlobUrl.value && previewType.value !== 'image') URL.revokeObjectURL(previewBlobUrl.value)
  for (const url of imageBlobCache.values()) URL.revokeObjectURL(url)
  imageBlobCache.clear()
  if (editImageUrl.value) URL.revokeObjectURL(editImageUrl.value)
  editStageResizeObserver?.disconnect()
  stopActiveStream()
})
</script>

<template>
  <div class="preview-window">
    <Teleport :to="actionsTarget ?? 'body'" :disabled="!actionsTarget">
      <button
        v-if="previewType === 'image' && previewBlobUrl && !editMode"
        class="preview-download-btn"
        @click="enterEditMode"
        title="Edit (crop &amp; rotate)"
      >
        <i class="bi bi-pencil"></i>
      </button>
      <button class="preview-download-btn" @click="downloadFromPreview" :disabled="previewLoading" title="Download">
        <i class="bi bi-download"></i>
      </button>
    </Teleport>

    <div class="preview-body">
      <div v-if="editMode" class="edit-toolbar">
        <button class="edit-btn" @click="rotateLeft" title="Rotate left"><i class="bi bi-arrow-counterclockwise"></i></button>
        <button class="edit-btn" @click="rotateRight" title="Rotate right"><i class="bi bi-arrow-clockwise"></i></button>
        <button class="edit-btn" :class="{ 'edit-btn-active': cropping }" @click="toggleCropping" title="Crop">
          <i class="bi bi-crop"></i>
        </button>
        <button v-if="cropping" class="edit-btn" @click="applyCrop" title="Apply crop">
          <i class="bi bi-check-lg"></i>
        </button>
        <span v-if="editError" class="edit-toolbar-error">{{ editError }}</span>
        <span class="edit-toolbar-spacer"></span>
        <button class="edit-btn edit-btn-text" @click="cancelEdit" :disabled="savingEdit">Cancel</button>
        <button class="edit-btn edit-btn-primary" @click="openSaveDialog" :disabled="savingEdit">Save…</button>
      </div>

      <div v-if="previewLoading" class="preview-state">
        <div class="spinner-border mb-3" role="status"><span class="visually-hidden">Loading…</span></div>
        <p v-if="previewExpectedBytes > 0" class="preview-progress-text">
          {{ formatSize(previewReceivedBytes) }} / {{ formatSize(previewExpectedBytes) }}
        </p>
        <p v-else class="preview-progress-text">Loading…</p>
      </div>

      <div v-else-if="previewError" class="preview-state">
        <i class="bi bi-exclamation-octagon display-6 mb-3"></i>
        <p class="mb-0">{{ previewError }}</p>
      </div>

      <div v-else-if="previewType === 'image' && previewBlobUrl && editMode" ref="editStageEl" class="preview-image-wrap">
        <img :src="editImageUrl" :alt="currentEntry.name" class="preview-image" ref="editImgEl" @load="onEditImageLoad" />
        <div v-if="cropping" class="crop-box" :style="cropBoxStyle" @pointerdown="onCropBodyPointerDown">
          <div class="crop-handle crop-handle-nw" @pointerdown.stop="onHandlePointerDown('nw', $event)"></div>
          <div class="crop-handle crop-handle-ne" @pointerdown.stop="onHandlePointerDown('ne', $event)"></div>
          <div class="crop-handle crop-handle-sw" @pointerdown.stop="onHandlePointerDown('sw', $event)"></div>
          <div class="crop-handle crop-handle-se" @pointerdown.stop="onHandlePointerDown('se', $event)"></div>
        </div>
      </div>

      <div v-else-if="previewType === 'image' && previewBlobUrl" class="preview-image-wrap">
        <button v-if="canGoPrev" class="preview-nav-btn preview-nav-btn--prev" @click="goPrev" title="Previous image">
          <i class="bi bi-chevron-left"></i>
        </button>
        <Transition :name="`image-slide-${navDirection}`">
          <img :key="previewBlobUrl" :src="previewBlobUrl" :alt="currentEntry.name" class="preview-image" @dblclick="toggleImageFullscreen" />
        </Transition>
        <div v-if="imageSwapping" class="preview-image-swap-spinner">
          <div class="spinner-border spinner-border-sm text-light" role="status"><span class="visually-hidden">Loading…</span></div>
        </div>
        <button v-if="canGoNext" class="preview-nav-btn preview-nav-btn--next" @click="goNext" title="Next image">
          <i class="bi bi-chevron-right"></i>
        </button>
      </div>

      <div v-else-if="previewType === 'audio' && previewBlobUrl" class="preview-audio-wrap">
        <div class="audio-icon"><i class="bi bi-music-note-beamed"></i></div>
        <p class="audio-name">{{ currentEntry.name }}</p>
        <audio :src="previewBlobUrl" controls autoplay class="preview-audio" @error="handleMediaError" />
      </div>

      <div v-else-if="previewType === 'video' && previewBlobUrl" class="preview-video-wrap">
        <video :src="previewBlobUrl" controls autoplay class="preview-video" @error="handleMediaError" />
      </div>

      <div v-else-if="previewType === 'pdf' && previewBlobUrl" class="preview-pdf-wrap">
        <iframe :src="previewBlobUrl" class="preview-pdf" />
      </div>

      <div v-else-if="previewType === 'text'" class="preview-text-wrap">
        <pre class="preview-text">{{ previewTextContent }}</pre>
      </div>
    </div>
  </div>

  <!-- Save-as dialog -->
  <Teleport to="body">
    <div v-if="showSaveDialog" class="save-dialog-overlay" @click.self="!savingEdit && (showSaveDialog = false)">
      <div class="save-dialog">
        <h4 class="save-dialog-title">Save image</h4>
        <label class="save-dialog-option">
          <input type="radio" name="save-mode" :checked="!saveAsNew" @change="saveAsNew = false" />
          Replace &quot;{{ currentEntry.name }}&quot;
        </label>
        <label class="save-dialog-option">
          <input type="radio" name="save-mode" :checked="saveAsNew" @change="saveAsNew = true" />
          Save as a new file
        </label>
        <input
          v-if="saveAsNew"
          v-model="saveFileName"
          type="text"
          class="save-dialog-input"
          placeholder="File name"
          @keyup.enter="confirmSave"
        />
        <p v-if="editError" class="save-dialog-error">{{ editError }}</p>
        <div class="save-dialog-actions">
          <button class="save-dialog-btn" @click="showSaveDialog = false" :disabled="savingEdit">Cancel</button>
          <button
            class="save-dialog-btn save-dialog-btn-primary"
            @click="confirmSave"
            :disabled="savingEdit || (saveAsNew && !saveFileName.trim())"
          >
            {{ savingEdit ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Upload progress toast -->
  <Teleport to="body">
  <Transition name="dl-toast">
    <div v-if="uploadProgress" class="dl-toast">
      <div class="dl-toast-header">
        <i class="bi bi-upload dl-toast-icon"></i>
        <span class="dl-toast-title">Saving</span>
        <button class="dl-toast-cancel" @click="uploadProgress.cancel()" title="Cancel">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <div class="dl-toast-name">{{ uploadProgress.name }}</div>
      <div class="dl-progress-bar-wrap">
        <div class="dl-progress-bar" :style="{ width: uploadProgress.total > 0 ? `${Math.min(100, Math.round(uploadProgress.sent / uploadProgress.total * 100))}%` : '0%' }"></div>
      </div>
      <div class="dl-toast-meta">
        <span>{{ formatSize(uploadProgress.sent) }} / {{ uploadProgress.total > 0 ? formatSize(uploadProgress.total) : '…' }}</span>
        <span>{{ uploadProgress.speed > 0 ? `${formatSize(Math.round(uploadProgress.speed))}/s` : '…' }}</span>
      </div>
    </div>
  </Transition>
  </Teleport>

  <!-- Download progress toast -->
  <Teleport to="body">
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
        <div class="dl-progress-bar" :style="{ width: downloadProgress.total > 0 ? `${Math.min(100, Math.round(downloadProgress.received / downloadProgress.total * 100))}%` : '0%' }"></div>
      </div>
      <div class="dl-toast-meta">
        <span>{{ formatSize(downloadProgress.received) }} / {{ downloadProgress.total > 0 ? formatSize(downloadProgress.total) : '…' }}</span>
        <span>{{ downloadProgress.speed > 0 ? `${formatSize(Math.round(downloadProgress.speed))}/s` : '…' }}</span>
      </div>
    </div>
  </Transition>
  </Teleport>
</template>

<style scoped>
.preview-window {
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
.preview-download-btn {
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
  transition: background 0.15s ease, color 0.15s ease;
}
.preview-download-btn:hover { background: #e2e8f0; color: #111827; }
.preview-download-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.preview-body { flex: 1; overflow: auto; display: flex; flex-direction: column; min-height: 0; }
.preview-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; text-align: center; padding: 2rem; color: #617182; min-height: 220px; }
.preview-progress-text { font-size: 0.85rem; color: #94a3b8; margin: 0; }

.preview-image-wrap { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; padding: 1rem; background: #0d0d0d; min-height: 300px; overflow: hidden; }
.preview-image { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px; }

.preview-image-swap-spinner {
  position: absolute;
  bottom: 0.75rem;
  right: 0.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.45);
}

.image-slide-next-enter-active,
.image-slide-prev-enter-active,
.image-slide-next-leave-active,
.image-slide-prev-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
/* Leaving image overlaps the entering one (both centered) instead of taking
   part in layout, so the crossfade doesn't shift/collapse the container. */
.image-slide-next-leave-active,
.image-slide-prev-leave-active {
  position: absolute;
  inset: 1rem;
  margin: auto;
}
.image-slide-next-leave-to { opacity: 0; transform: translateX(-28px); }
.image-slide-prev-leave-to { opacity: 0; transform: translateX(28px); }
.image-slide-next-enter-from { opacity: 0; transform: translateX(28px); }
.image-slide-prev-enter-from { opacity: 0; transform: translateX(-28px); }

.preview-nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.45);
  color: #fff;
  font-size: 1.1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease;
  z-index: 1;
}
.preview-nav-btn:hover { background: rgba(15, 23, 42, 0.7); }
.preview-nav-btn--prev { left: 0.75rem; }
.preview-nav-btn--next { right: 0.75rem; }

.preview-audio-wrap { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 1.25rem; padding: 3rem 2rem; }
.audio-icon { font-size: 4rem; color: #94a3b8; line-height: 1; }
.audio-name { font-weight: 600; color: #21313f; text-align: center; margin: 0; overflow-wrap: anywhere; }
.preview-audio { width: 100%; max-width: 420px; }

.preview-video-wrap { flex: 1; display: flex; align-items: center; justify-content: center; background: #0d0d0d; min-height: 300px; overflow: hidden; }
.preview-video { max-width: 100%; max-height: 100%; width: 100%; height: 100%; object-fit: contain; }

.preview-pdf-wrap { flex: 1; display: flex; min-height: 0; }
.preview-pdf { width: 100%; height: 100%; border: 0; }

.preview-text-wrap { flex: 1; overflow: auto; background: #272822; padding: 1.25rem; }
.preview-text { margin: 0; font-size: 0.82rem; line-height: 1.65; color: #f8f8f2; white-space: pre-wrap; word-break: break-word; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; }

/* Crop & rotate editor */
.edit-toolbar {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem 0.75rem;
  background: #1e293b;
  border-bottom: 1px solid #0f172a;
  flex-shrink: 0;
}

.edit-btn {
  height: 30px;
  padding: 0 0.65rem;
  border: 0;
  border-radius: 7px;
  background: #334155;
  color: #e2e8f0;
  font-size: 0.85rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.edit-btn:hover:not(:disabled) { background: #475569; }
.edit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.edit-btn-active { background: var(--theme-primary, #3b82f6); color: #fff; }
.edit-btn-text { background: transparent; color: #cbd5e1; }
.edit-btn-text:hover:not(:disabled) { background: #334155; color: #fff; }
.edit-btn-primary { background: var(--theme-primary, #3b82f6); color: #fff; font-weight: 600; }
.edit-btn-primary:hover:not(:disabled) { background: #2563eb; }

.edit-toolbar-spacer { flex: 1; }
.edit-toolbar-error { font-size: 0.78rem; color: #fca5a5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.crop-box {
  position: absolute;
  border: 2px solid #fff;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.55);
  cursor: move;
  touch-action: none;
}

.crop-handle {
  position: absolute;
  width: 14px;
  height: 14px;
  background: #fff;
  border: 2px solid var(--theme-primary, #3b82f6);
  border-radius: 50%;
  touch-action: none;
}
.crop-handle-nw { top: -7px; left: -7px; cursor: nwse-resize; }
.crop-handle-ne { top: -7px; right: -7px; cursor: nesw-resize; }
.crop-handle-sw { bottom: -7px; left: -7px; cursor: nesw-resize; }
.crop-handle-se { bottom: -7px; right: -7px; cursor: nwse-resize; }

/* Save-as dialog */
.save-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.5);
  z-index: 3100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.save-dialog {
  width: 100%;
  max-width: 340px;
  background: #fff;
  border-radius: 12px;
  padding: 1.25rem;
  box-shadow: 0 16px 40px rgba(15, 23, 42, 0.25);
}

.save-dialog-title { margin: 0 0 0.85rem; font-size: 1rem; font-weight: 700; color: #1e293b; }

.save-dialog-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: #334155;
  padding: 0.35rem 0;
  cursor: pointer;
}

.save-dialog-input {
  width: calc(100% - 1.6rem);
  margin: 0.35rem 0 0.25rem 1.6rem;
  padding: 0.4rem 0.6rem;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  font-size: 0.85rem;
  box-sizing: border-box;
}
.save-dialog-input:focus { outline: none; border-color: var(--theme-primary, #3b82f6); }

.save-dialog-error { font-size: 0.78rem; color: #dc2626; margin: 0.35rem 0 0; }

.save-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}

.save-dialog-btn {
  padding: 0.4rem 0.9rem;
  border: 1px solid #d9dee4;
  border-radius: 7px;
  background: #fff;
  color: #334155;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}
.save-dialog-btn:hover:not(:disabled) { background: #f1f5f9; }
.save-dialog-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.save-dialog-btn-primary { background: var(--theme-primary, #3b82f6); border-color: var(--theme-primary, #3b82f6); color: #fff; }
.save-dialog-btn-primary:hover:not(:disabled) { background: #2563eb; }

/* Download toast */
.dl-toast {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  width: 280px;
  background: #1e293b;
  border-radius: 14px;
  padding: 0.85rem 1rem;
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  z-index: 3000;
}
.dl-toast-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
.dl-toast-icon { color: #60a5fa; font-size: 0.9rem; }
.dl-toast-title { font-size: 0.8rem; font-weight: 700; color: #f1f5f9; flex: 1; }
.dl-toast-cancel { background: transparent; border: 0; color: #94a3b8; font-size: 0.8rem; cursor: pointer; padding: 0; display: flex; }
.dl-toast-cancel:hover { color: #f1f5f9; }
.dl-toast-name { font-size: 0.75rem; color: #94a3b8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 0.5rem; }
.dl-progress-bar-wrap { height: 4px; background: #334155; border-radius: 2px; margin-bottom: 0.35rem; }
.dl-progress-bar { height: 100%; background: #60a5fa; border-radius: 2px; transition: width 0.3s; }
.dl-toast-meta { display: flex; justify-content: space-between; font-size: 0.72rem; color: #64748b; }
</style>
