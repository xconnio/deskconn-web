/**
 * Client side of downloading a file over deskconn's stream-based file-transfer
 * protocol (see services/fileStream.ts) — shared by FilePreviewModal.vue (its
 * own Download button / oversized-file fallback) and EmbeddedDesktopFiles.vue
 * (files that have no previewer at all, which skip opening a preview window
 * and go straight to a download).
 */
import { type Ref } from 'vue'
import { type Session } from '@/services/xconn'
import { requestRange } from '@/services/fileStream'
import { downloadUrl } from '@/utils/download'
import { isFirefoxBrowser } from '@/utils/fileTypes'

export type DownloadEntry = { path: string; name: string; size: number }
export type DownloadProgressState = { name: string; received: number; total: number; speed: number; cancel: () => void }

export async function streamFileData(
  session: Session,
  realm: string,
  remotePath: string,
  size: number,
  onChunk: (chunk: Uint8Array, expectedTotal: number) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const { stream } = await requestRange(session, realm, remotePath, 0, size, signal)
  const reader = stream.getReader()
  try {
    while (true) {
      if (signal?.aborted) throw new Error('cancelled')
      const { done, value } = await reader.read()
      if (done) break
      await onChunk(value, size)
    }
  } finally {
    reader.releaseLock()
  }
}

let downloadServiceWorker: ServiceWorker | null = null
let downloadServiceWorkerReadyPromise: Promise<ServiceWorker | null> | null = null

export async function ensureDownloadServiceWorker(): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null
  if (downloadServiceWorker) return downloadServiceWorker
  if (!downloadServiceWorkerReadyPromise) {
    downloadServiceWorkerReadyPromise = (async () => {
      await navigator.serviceWorker.register('/sw-download.js', { scope: '/' })
      await navigator.serviceWorker.ready
      if (navigator.serviceWorker.controller) {
        downloadServiceWorker = navigator.serviceWorker.controller
        return downloadServiceWorker
      }
      downloadServiceWorker = await new Promise<ServiceWorker>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (navigator.serviceWorker.controller) resolve(navigator.serviceWorker.controller)
        }, { once: true })
      })
      return downloadServiceWorker
    })().catch((err) => { downloadServiceWorkerReadyPromise = null; throw err })
  }
  return downloadServiceWorkerReadyPromise
}

async function downloadFileWithSavePicker(
  session: Session,
  realm: string,
  entry: DownloadEntry,
  progress: Ref<DownloadProgressState | null>,
  controller: AbortController,
  armStall: () => void,
  clearStall: () => void,
  onError: (err: unknown) => void,
) {
  let writable: FileSystemWritableFileStream | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = await (window as any).showSaveFilePicker({ suggestedName: entry.name })
    writable = await handle.createWritable()
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === 'AbortError') return
    return
  }

  const startTime = Date.now()
  let received = 0
  progress.value = { name: entry.name, received: 0, total: entry.size, speed: 0, cancel: () => controller.abort() }
  armStall()

  try {
    await streamFileData(session, realm, entry.path, entry.size, async (chunk) => {
      armStall()
      await writable!.write(chunk.slice())
      received += chunk.length
      if (!progress.value) return
      progress.value.received = received
      const elapsed = (Date.now() - startTime) / 1000
      progress.value.speed = elapsed > 0 ? received / elapsed : 0
    }, controller.signal)
    await writable!.close()
  } catch (err) {
    try { await writable?.abort() } catch { /* ignore */ }
    onError(err)
  } finally {
    clearStall(); progress.value = null
  }
}

async function downloadFileWithBrowserDownload(
  session: Session,
  realm: string,
  entry: DownloadEntry,
  signal: AbortSignal,
  armStall: () => void,
  clearStall: () => void,
) {
  armStall()
  const sw = downloadServiceWorker ?? await ensureDownloadServiceWorker()
  if (!sw) throw new Error('Browser downloads are not available in this browser')

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  let sentMeta = false
  let pendingPulls = 0
  let bridgeError: Error | null = null
  let pullWaiter: (() => void) | null = null
  const mc = new MessageChannel()
  const keepAlive = window.setInterval(() => sw.postMessage({ type: 'ping', id }), 10_000)

  function resolvePull() {
    if (pullWaiter) { const r = pullWaiter; pullWaiter = null; r(); return }
    pendingPulls++
  }
  function waitForPull() {
    if (bridgeError) return Promise.reject(bridgeError)
    if (pendingPulls > 0) { pendingPulls--; return Promise.resolve() }
    return new Promise<void>((resolve, reject) => {
      pullWaiter = () => { if (bridgeError) reject(bridgeError); else resolve() }
    })
  }

  mc.port1.onmessage = (event) => {
    const data = event.data ?? {}
    if (data.type === 'pull') { resolvePull(); return }
    if (data.type === 'error') {
      bridgeError = new Error(data.message || 'Download bridge failed')
      if (pullWaiter) { const r = pullWaiter; pullWaiter = null; r() }
    }
  }
  sw.postMessage({ type: 'download', id, filename: entry.name }, [mc.port2])

  downloadUrl(`/_dl/${id}`, entry.name)

  try {
    await streamFileData(session, realm, entry.path, entry.size, async (chunk) => {
      armStall()
      if (!sentMeta) {
        mc.port1.postMessage({ type: 'meta', filename: entry.name, size: entry.size })
        sentMeta = true
      }
      await waitForPull()
      if (bridgeError) throw bridgeError
      const payload = chunk.slice().buffer
      mc.port1.postMessage({ type: 'chunk', chunk: payload }, [payload])
    }, signal)
    mc.port1.postMessage({ type: 'close' })
  } catch (err) {
    mc.port1.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'Download failed' })
    throw err
  } finally {
    window.clearInterval(keepAlive); clearStall()
  }
}

/** Downloads `entry` to the client, reporting progress into `progress` when the
 * File System Access API is available (Firefox and the plain-browser-download
 * fallback have no progress signal of their own). Failures are logged and
 * passed to `onFailure` (if given) rather than thrown — there's no in-flight
 * caller left to usefully catch them by the time most of these surface. */
export async function downloadFile(
  session: Session,
  realm: string,
  entry: DownloadEntry,
  progress: Ref<DownloadProgressState | null>,
  onFailure?: (err: unknown) => void,
): Promise<void> {
  const STALL_MS = 20_000
  const controller = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let stalledOut = false

  function armStall() {
    if (stallTimer !== null) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => { stalledOut = true; controller.abort() }, STALL_MS)
  }
  function clearStall() {
    if (stallTimer !== null) { clearTimeout(stallTimer); stallTimer = null }
  }
  function onError(err: unknown) {
    if (stalledOut) { onFailure?.(new Error('Download stalled — machine may have disconnected.')); return }
    if (controller.signal.aborted) return
    if (err instanceof Error) console.warn('Download failed:', err.message)
    onFailure?.(err)
  }

  if (!isFirefoxBrowser() && 'showSaveFilePicker' in window) {
    await downloadFileWithSavePicker(session, realm, entry, progress, controller, armStall, clearStall, onError); return
  }
  try {
    await downloadFileWithBrowserDownload(session, realm, entry, controller.signal, armStall, clearStall)
  } catch (err) {
    clearStall(); onError(err)
  }
}
