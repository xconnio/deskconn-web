// Client side of deskconn's stream-based file-transfer protocol: a transfer
// opens a raw WebRTC data channel (P2P) or WebTransport stream (relay) on
// the caller's single existing connection, does a per-stream X25519 key
// exchange, then an encrypted control message says what to do ('read' /
// 'init' + 'write') followed by raw encrypted byte chunks (see
// filestreamencryption.go/filetransferp2p.go and quictransfer.go).
//
// Anything over PARALLEL_CHUNK_SIZE is split into that many byte ranges and
// fetched/sent over up to PARALLEL_WORKERS channels/streams in parallel
// (mirroring the CLI); downloads reassemble the out-of-order pieces back
// into one ordered stream (ChunkReassembler), uploads don't need to since
// the server writes each chunk at its own offset. Anything smaller skips
// all of that for a plain single-channel/single-stream path instead
// (p2pReadRange/webTransportReadRange).
import { getWebRTCSession } from './rtcRegistry'
import type { WampSession } from './wamp'
import { baseName } from '@/utils/filePath'
import {
  createX25519KeyPair,
  deriveSessionKeys,
  encryptPayload,
  decryptPayload,
  bytesToBase64,
  base64ToBytes,
  type EncryptionKeys,
} from '@/utils/encryption'

const CHANNEL_LABEL = 'file-stream'

export class NoDirectConnectionError extends Error {
  constructor() {
    super('No connection to this device')
    this.name = 'NoDirectConnectionError'
  }
}

// True whenever a raw stream (either transport) can be opened at all — the
// caller no longer needs to care which one, both support arbitrary-offset
// range reads identically.
export function canStreamRanges(session: WampSession | null | undefined): boolean {
  if (!session) return false
  if (getWebRTCSession(session)) return true
  return typeof session.openStream === 'function'
}

interface FSRequest {
  op: 'read' | 'init' | 'write'
  path?: string
  rel_path?: string
  offset?: number
  length?: number
  entries?: { rel_path: string; size: number; mode: number; is_dir: boolean }[]
  source_is_dir?: boolean
  target_is_dir_hint?: boolean
}

interface FSResponse {
  ok: boolean
  error?: string
}

export interface RangeResult {
  stream: ReadableStream<Uint8Array>
}

export interface UploadProgress {
  sent: number
  total: number
  speed: number
}

function responseError(resp: FSResponse): Error {
  return new Error(resp.error || 'remote operation failed')
}

function linkAbort(signal?: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller
}

// Bounds the per-stream key exchange (and, for WebTransport, the one-shot
// request/response) — mirrors p2pRequestTimeout in filetransferp2p.go. A
// stalled or dropped first round-trip on a fresh channel/stream would
// otherwise hang forever with no way to cancel it (see p2pKeyExchange /
// openWebTransportStream), since the caller-supplied AbortSignal only gets
// wired up once these return.
const HANDSHAKE_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => { window.clearTimeout(timer); resolve(v) },
      (e: unknown) => { window.clearTimeout(timer); reject(e) },
    )
  })
}

// ========================= Parallel chunk-worker pool =========================
// Mirrors filetransfer.go's planChunks/effectiveWorkers/runChunkWorkers: the
// unit of work a worker pulls off the shared queue, not the wire message
// size (see P2P_MESSAGE_SIZE/WEBTRANSPORT_MESSAGE_SIZE below for that).

const PARALLEL_CHUNK_SIZE = 4 * 1024 * 1024 // 4MB
const PARALLEL_WORKERS = 4

interface Chunk {
  offset: number
  length: number
}

function planChunks(offset: number, length: number): Chunk[] {
  const chunks: Chunk[] = []
  const end = offset + length
  for (let off = offset; off < end; off += PARALLEL_CHUNK_SIZE) {
    chunks.push({ offset: off, length: Math.min(PARALLEL_CHUNK_SIZE, end - off) })
  }
  return chunks
}

function effectiveWorkers(chunkCount: number): number {
  return Math.max(1, Math.min(PARALLEL_WORKERS, chunkCount))
}

// Runs workerFn workers times concurrently, each repeatedly pulling the next
// chunk off the shared queue (nextJob) until it's drained. The first worker
// error aborts the shared AbortController so sibling workers stop claiming
// new chunks, then propagates once every worker has actually returned.
async function runChunkWorkers(
  chunks: Chunk[],
  workers: number,
  abort: AbortController,
  workerFn: (nextJob: () => Chunk | undefined) => Promise<void>,
): Promise<void> {
  if (chunks.length === 0) return

  let i = 0
  const nextJob = (): Chunk | undefined => {
    if (abort.signal.aborted) return undefined
    return i < chunks.length ? chunks[i++] : undefined
  }

  let firstError: unknown
  await Promise.all(
    Array.from({ length: workers }, () =>
      workerFn(nextJob).catch((err: unknown) => {
        firstError ??= err
        abort.abort()
      }),
    ),
  )
  if (firstError !== undefined) throw firstError instanceof Error ? firstError : new Error(String(firstError))
}

interface ChunkWriteWorker {
  writeChunk(offset: number, length: number, onSent: (n: number) => void): Promise<void>
  close(): void
}

// onData is called once per wire piece (16KB/64KB, not once per whole
// PARALLEL_CHUNK_SIZE job) so a parallel download streams out as it
// arrives instead of buffering a whole 4MB chunk before delivering any of
// it — the same responsiveness the single-stream path already had.
interface ChunkReadWorker {
  readChunk(offset: number, length: number, onData: (pieceOffset: number, data: Uint8Array) => void): Promise<void>
  close(): void
}

// Reassembles pieces completed by parallel workers — which land in whatever
// order their network round-trips happen to finish — back into the single
// ordered byte stream every caller (save-to-disk, browser-download bridge,
// preview buffering, media range-request bridge) expects.
class ChunkReassembler {
  private pending = new Map<number, Uint8Array>()
  private nextOffset: number
  private readonly endOffset: number
  private done = false

  constructor(private controller: ReadableStreamDefaultController<Uint8Array>, startOffset: number, length: number) {
    this.nextOffset = startOffset
    this.endOffset = startOffset + length
    if (this.nextOffset >= this.endOffset) this.close()
  }

  push(pieceOffset: number, data: Uint8Array): void {
    if (this.done) return
    this.pending.set(pieceOffset, data)
    while (this.pending.has(this.nextOffset)) {
      const next = this.pending.get(this.nextOffset)!
      this.pending.delete(this.nextOffset)
      this.controller.enqueue(next)
      this.nextOffset += next.length
    }
    if (this.nextOffset >= this.endOffset) this.close()
  }

  fail(err: Error): void {
    if (this.done) return
    this.done = true
    try { this.controller.error(err) } catch { /* already closed/errored */ }
  }

  private close(): void {
    this.done = true
    try { this.controller.close() } catch { /* already closed */ }
  }
}

// Shared orchestration for both transports' parallel download path: open
// effectiveWorkers(chunks.length) workers, each pulling chunks off the
// shared queue and reassembling their pieces back into offset order.
// Resolves with the stream immediately — same as the single-stream path,
// which also hands back a stream before any data has necessarily arrived;
// a bad path/permission error surfaces as a stream error on first read
// rather than rejecting this call, since every worker would hit the same
// error independently anyway.
function readRangeParallel(
  chunks: Chunk[],
  startOffset: number,
  totalLength: number,
  openWorker: (signal: AbortSignal) => Promise<ChunkReadWorker>,
  signal?: AbortSignal,
): RangeResult {
  const abort = linkAbort(signal)
  let streamController!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller },
    cancel() { abort.abort() },
  })
  const reassembler = new ChunkReassembler(streamController, startOffset, totalLength)

  void runChunkWorkers(chunks, effectiveWorkers(chunks.length), abort, async (nextJob) => {
    const worker = await openWorker(abort.signal)
    try {
      let job: Chunk | undefined
      while ((job = nextJob())) {
        await worker.readChunk(job.offset, job.length, (pieceOffset, data) => reassembler.push(pieceOffset, data))
      }
    } finally {
      worker.close()
    }
  }).catch((err: unknown) => reassembler.fail(err instanceof Error ? err : new Error('download failed')))

  return { stream }
}

// Always single-channel/single-stream, regardless of range size — for media
// range requests (video/audio seeking via the Service Worker Range-request
// bridge in FilePreviewModal.vue). Those are inherently short-lived and get
// cancelled constantly as playback seeks elsewhere (a seek near the start of
// a large file routinely asks for an open-ended range — "from here to EOF"
// — that the player only reads a sliver of before cancelling for the next
// seek). Parallel chunk workers optimize for a one-shot bulk transfer that
// runs to completion, which is the opposite access pattern, so range
// requests use this directly instead of the auto-routing requestRange below.
export async function requestRangeStream(
  session: WampSession,
  realm: string,
  path: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<RangeResult> {
  const usesP2P = !!getWebRTCSession(session)
  if (!usesP2P && typeof session?.openStream !== 'function') throw new NoDirectConnectionError()

  const relPath = baseName(path)
  return usesP2P
    ? p2pReadRange(session, path, relPath, offset, length, signal)
    : webTransportReadRange(session, realm, path, relPath, offset, length, signal)
}

// A range that fits in a single PARALLEL_CHUNK_SIZE chunk goes through
// requestRangeStream unchanged — only a range that actually splits into
// more than one chunk takes the parallel path, so small transfers (small-
// file downloads) never carry any of that added complexity. Use this for
// one-shot bulk transfers (file downloads); use requestRangeStream directly
// for media range requests (see its own doc comment for why).
export async function requestRange(
  session: WampSession,
  realm: string,
  path: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<RangeResult> {
  const usesP2P = !!getWebRTCSession(session)
  if (!usesP2P && typeof session?.openStream !== 'function') throw new NoDirectConnectionError()

  const relPath = baseName(path)
  const chunks = planChunks(offset, length)
  if (chunks.length <= 1) return requestRangeStream(session, realm, path, offset, length, signal)

  return readRangeParallel(
    chunks, offset, length,
    usesP2P
      ? (s) => openP2PReadWorker(session, path, relPath, s)
      : (s) => openWebTransportReadWorker(session, realm, path, relPath, s),
    signal,
  )
}

export async function uploadFile(
  session: WampSession,
  realm: string,
  destDir: string,
  fileName: string,
  file: Blob,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const usesP2P = !!getWebRTCSession(session)
  if (!usesP2P && typeof session?.openStream !== 'function') throw new NoDirectConnectionError()

  const initReq: FSRequest = {
    op: 'init',
    path: destDir,
    entries: [{ rel_path: fileName, size: file.size, mode: 0, is_dir: false }],
    source_is_dir: false,
    target_is_dir_hint: true,
  }
  if (usesP2P) await p2pOneShotRequest(session, initReq, signal)
  else await webTransportRequest(session, realm, initReq, signal)

  if (file.size === 0) return

  const chunks = planChunks(0, file.size)
  const abort = linkAbort(signal)
  let sentTotal = 0
  const start = Date.now()
  function reportProgress(n: number) {
    sentTotal += n
    const elapsed = (Date.now() - start) / 1000
    onProgress?.({ sent: sentTotal, total: file.size, speed: elapsed > 0 ? sentTotal / elapsed : 0 })
  }

  await runChunkWorkers(chunks, effectiveWorkers(chunks.length), abort, async (nextJob) => {
    const worker = usesP2P
      ? await openP2PWriteWorker(session, destDir, fileName, false, true, file, abort.signal)
      : await openWebTransportWriteWorker(session, realm, destDir, fileName, false, true, file, abort.signal)
    try {
      let job: Chunk | undefined
      while ((job = nextJob())) {
        await worker.writeChunk(job.offset, job.length, reportProgress)
      }
    } finally {
      worker.close()
    }
  })
}

// ============================== P2P (WebRTC) ==============================

const p2pMsgControl = 0
const p2pMsgData = 1

// fileStreamChunkSize on the Go side — the wire message size within one
// read/write request, not the parallel-worker job unit (PARALLEL_CHUNK_SIZE).
const P2P_MESSAGE_SIZE = 16 * 1024
const P2P_MAX_BUFFERED = 512 * 1024
const P2P_LOW_BUFFERED = 256 * 1024

// Exported: also used by shellStream.ts, which sends the same kind-byte
// envelope shape over both a P2P data channel and (unlike file transfer,
// which never needs it — see the header comment) a WebTransport stream too.
export function p2pEnvelope(kind: number, plaintext: Uint8Array, key: Uint8Array): Uint8Array<ArrayBuffer> {
  const ciphertext = encryptPayload(plaintext, key)
  const envelope = new Uint8Array(1 + ciphertext.length)
  envelope[0] = kind
  envelope.set(ciphertext, 1)
  return envelope
}

export function p2pDecryptEnvelope(data: ArrayBuffer, key: Uint8Array): { kind: number; plaintext: Uint8Array } {
  const bytes = new Uint8Array(data)
  const kind = bytes[0]
  if (kind === undefined) throw new Error('empty message')
  return { kind, plaintext: decryptPayload(bytes.slice(1), key) }
}

// label defaults to the file-stream channel label so existing callers are
// unaffected; shellStream.ts passes shellChannelLabel ("shell") instead —
// the server classifies a P2P shell channel by label rather than by its
// first message's content (see HandleAuxDataChannel in iptunnel.go).
export async function openP2PChannel(
  session: WampSession, signal?: AbortSignal, label: string = CHANNEL_LABEL,
): Promise<RTCDataChannel> {
  const webrtc = getWebRTCSession(session)
  if (!webrtc) throw new NoDirectConnectionError()
  const channel = await webrtc.openDataChannel(label)
  if (signal?.aborted) {
    channel.close()
    throw new Error('cancelled')
  }
  return channel
}

// Sends our plaintext public key as the channel's first (text) message,
// waits for the peer's plaintext public key back, derives session keys.
// Mirrors p2pClientKeyExchange in filestreamencryption.go. Times out (rather
// than hanging forever) if the peer never replies, and rejects immediately
// if the channel closes/errors mid-handshake — the caller is expected to
// have already wired its own abort signal to close the channel, so this is
// what turns that close into a real rejection instead of a silent stall.
export async function p2pKeyExchange(channel: RTCDataChannel): Promise<EncryptionKeys> {
  const { publicKey, privateKey } = createX25519KeyPair()

  const serverPublicKey = await new Promise<Uint8Array>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      channel.removeEventListener('message', onMessage)
      channel.removeEventListener('close', onClosed)
      channel.removeEventListener('error', onClosed)
      action()
    }
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      try {
        const msg = JSON.parse(event.data) as { public_key?: string }
        if (!msg.public_key) throw new Error('missing public key in key exchange response')
        const key = base64ToBytes(msg.public_key)
        finish(() => resolve(key))
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error('invalid key exchange message')))
      }
    }
    const onClosed = () => finish(() => reject(new Error('connection closed')))
    const timer = window.setTimeout(
      () => finish(() => reject(new Error('timed out waiting for key exchange'))),
      HANDSHAKE_TIMEOUT_MS,
    )
    channel.addEventListener('message', onMessage)
    channel.addEventListener('close', onClosed)
    channel.addEventListener('error', onClosed)
    channel.send(JSON.stringify({ public_key: bytesToBase64(publicKey) }))
  })

  if (serverPublicKey.length !== 32) throw new Error('invalid peer public key length')
  return deriveSessionKeys(privateKey, serverPublicKey)
}

// One-shot request/response on its own channel — the server closes the
// channel right after replying (see serveWebRTCInit), so it can't be reused
// for a follow-up read/write.
async function p2pOneShotRequest(session: WampSession, req: FSRequest, signal?: AbortSignal): Promise<FSResponse> {
  const channel = await openP2PChannel(session, signal)
  // Wired before the key exchange (not after) so a cancel during the
  // handshake actually closes the channel instead of being a no-op until
  // the handshake happens to finish on its own.
  signal?.addEventListener('abort', () => { try { channel.close() } catch { /* ignore */ } }, { once: true })
  try {
    const keys = await p2pKeyExchange(channel)
    return await withTimeout(new Promise<FSResponse>((resolve, reject) => {
      channel.onmessage = (event: MessageEvent) => {
        if (!(event.data instanceof ArrayBuffer)) return
        try {
          const { kind, plaintext } = p2pDecryptEnvelope(event.data, keys.decryptKey)
          if (kind !== p2pMsgControl) return
          const resp = JSON.parse(new TextDecoder().decode(plaintext)) as FSResponse
          if (!resp.ok) { reject(responseError(resp)); return }
          resolve(resp)
        } catch (err) {
          reject(err instanceof Error ? err : new Error('invalid response'))
        }
      }
      channel.onclose = () => reject(new Error('connection closed'))
      channel.onerror = () => reject(new Error('connection error'))
      channel.send(p2pEnvelope(p2pMsgControl, new TextEncoder().encode(JSON.stringify(req)), keys.encryptKey))
    }), HANDSHAKE_TIMEOUT_MS, 'timed out waiting for response')
  } finally {
    try { channel.close() } catch { /* ignore */ }
  }
}

// Single channel, single request, streaming the response straight to the
// caller as it arrives (rather than buffering the whole range before
// returning any of it) — one channel per download, matching the original
// working implementation. Resolves as soon as the server acks the request;
// the caller reads the actual bytes off the returned stream as they land.
function p2pReadRange(
  session: WampSession,
  path: string,
  relPath: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<RangeResult> {
  return new Promise<RangeResult>((resolveOuter, rejectOuter) => {
    void (async () => {
      const channel = await openP2PChannel(session, signal)
      // Wired before the key exchange (not after) so a cancel during the
      // handshake actually closes the channel instead of being a no-op
      // until the handshake happens to finish on its own.
      signal?.addEventListener('abort', () => { try { channel.close() } catch { /* ignore */ } }, { once: true })
      const keys = await p2pKeyExchange(channel)

      let ackSettled = false
      let done = false
      let received = 0
      let streamController!: ReadableStreamDefaultController<Uint8Array>

      const stream = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller },
        cancel() { try { channel.close() } catch { /* ignore */ } },
      })

      function fail(err: Error) {
        if (done) return
        done = true
        if (!ackSettled) { ackSettled = true; rejectOuter(err) }
        else { try { streamController.error(err) } catch { /* already closed */ } }
        try { channel.close() } catch { /* ignore */ }
      }

      channel.onmessage = (event: MessageEvent) => {
        if (!(event.data instanceof ArrayBuffer)) return
        let kind: number, plaintext: Uint8Array
        try { ({ kind, plaintext } = p2pDecryptEnvelope(event.data, keys.decryptKey)) }
        catch (err) { fail(err instanceof Error ? err : new Error('decrypt failed')); return }

        if (!ackSettled) {
          if (kind !== p2pMsgControl) return
          let resp: FSResponse
          try { resp = JSON.parse(new TextDecoder().decode(plaintext)) as FSResponse }
          catch { fail(new Error('invalid response')); return }
          if (!resp.ok) { fail(responseError(resp)); return }
          ackSettled = true
          resolveOuter({ stream })
          return
        }

        if (kind !== p2pMsgData || done) return
        received += plaintext.length
        streamController.enqueue(plaintext)
        if (received >= length) {
          done = true
          try { streamController.close() } catch { /* ignore */ }
          try { channel.close() } catch { /* ignore */ }
        }
      }
      channel.onclose = () => fail(new Error('connection closed before transfer finished'))
      channel.onerror = () => fail(new Error('connection error'))

      const req: FSRequest = { op: 'read', path, rel_path: relPath, offset, length }
      channel.send(p2pEnvelope(p2pMsgControl, new TextEncoder().encode(JSON.stringify(req)), keys.encryptKey))
    })().catch(rejectOuter)
  })
}

// Backs the parallel download path (large ranges only — see requestRange):
// opens one data channel and keeps it for the lifetime of the worker,
// reusing it across every chunk that worker is assigned, mirroring
// p2pReadWorker in filetransferp2p.go. A single activeReject covers both
// the ack-wait and the data-wait phase of each readChunk call, so a channel
// close/error at any point during a chunk correctly rejects whichever
// phase is in flight instead of only one of them.
async function openP2PReadWorker(session: WampSession, path: string, relPath: string, signal: AbortSignal): Promise<ChunkReadWorker> {
  const channel = await openP2PChannel(session, signal)
  // Wired before the key exchange (not after) so a cancel during the
  // handshake actually closes the channel instead of being a no-op until
  // the handshake happens to finish on its own.
  signal.addEventListener('abort', () => { try { channel.close() } catch { /* ignore */ } }, { once: true })
  const keys = await p2pKeyExchange(channel)

  let ackResolve: ((r: FSResponse) => void) | null = null
  let onDataPiece: ((data: Uint8Array) => void) | null = null
  let activeReject: ((e: Error) => void) | null = null
  let closedErr: Error | null = null

  channel.onmessage = (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) return
    let kind: number, plaintext: Uint8Array
    try { ({ kind, plaintext } = p2pDecryptEnvelope(event.data, keys.decryptKey)) } catch { return }
    if (kind === p2pMsgControl) {
      try {
        const resp = JSON.parse(new TextDecoder().decode(plaintext)) as FSResponse
        ackResolve?.(resp)
      } catch { /* ignore malformed frame */ }
      return
    }
    if (kind === p2pMsgData) onDataPiece?.(plaintext)
  }
  const onClosed = () => {
    closedErr = new Error('connection closed')
    activeReject?.(closedErr)
  }
  channel.onclose = onClosed
  channel.onerror = onClosed

  function readChunk(offset: number, length: number, onData: (pieceOffset: number, data: Uint8Array) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        ackResolve = null
        onDataPiece = null
        activeReject = null
        action()
      }

      if (closedErr) { finish(() => reject(closedErr!)); return }
      activeReject = (err: Error) => finish(() => reject(err))

      let received = 0
      let pos = offset
      ackResolve = (resp: FSResponse) => {
        if (!resp.ok) { finish(() => reject(responseError(resp))); return }
        if (length === 0) finish(resolve)
      }
      onDataPiece = (piece: Uint8Array) => {
        onData(pos, piece)
        pos += piece.length
        received += piece.length
        if (received >= length) finish(resolve)
      }

      const req: FSRequest = { op: 'read', path, rel_path: relPath, offset, length }
      channel.send(p2pEnvelope(p2pMsgControl, new TextEncoder().encode(JSON.stringify(req)), keys.encryptKey))
    })
  }

  return { readChunk, close: () => { try { channel.close() } catch { /* ignore */ } } }
}

// Upload counterpart to p2pReadRange: unlike downloads, uploads DO use the
// parallel chunk-worker pool (see the top-of-file comment for why) — this
// opens one data channel and keeps it for the lifetime of the worker,
// reusing it across every chunk that worker is assigned. Mirrors
// p2pWriteWorker in filetransferp2p.go.
async function openP2PWriteWorker(
  session: WampSession,
  path: string,
  relPath: string,
  sourceIsDir: boolean,
  targetIsDirHint: boolean,
  file: Blob,
  signal: AbortSignal,
): Promise<ChunkWriteWorker> {
  const channel = await openP2PChannel(session, signal)
  // Wired before the key exchange (not after) so a cancel during the
  // handshake actually closes the channel instead of being a no-op until
  // the handshake happens to finish on its own.
  signal.addEventListener('abort', () => { try { channel.close() } catch { /* ignore */ } }, { once: true })
  const keys = await p2pKeyExchange(channel)

  channel.bufferedAmountLowThreshold = P2P_LOW_BUFFERED
  let bufferedLowResolve: (() => void) | null = null
  channel.onbufferedamountlow = () => { const wake = bufferedLowResolve; bufferedLowResolve = null; wake?.() }

  let ackResolve: ((r: FSResponse) => void) | null = null
  let ackReject: ((e: Error) => void) | null = null
  let closedErr: Error | null = null
  channel.onmessage = (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) return
    try {
      const { kind, plaintext } = p2pDecryptEnvelope(event.data, keys.decryptKey)
      if (kind !== p2pMsgControl) return
      const resp = JSON.parse(new TextDecoder().decode(plaintext)) as FSResponse
      ackResolve?.(resp)
    } catch { /* ignore malformed frame */ }
  }
  const onClosed = () => {
    closedErr = new Error('connection closed')
    ackReject?.(closedErr)
    const wake = bufferedLowResolve; bufferedLowResolve = null; wake?.()
  }
  channel.onclose = onClosed
  channel.onerror = onClosed

  function waitForAck(): Promise<FSResponse> {
    if (closedErr) return Promise.reject(closedErr)
    return new Promise((resolve, reject) => { ackResolve = resolve; ackReject = reject })
  }

  async function writeChunk(chunkOffset: number, chunkLength: number, onSent: (n: number) => void): Promise<void> {
    const req: FSRequest = {
      op: 'write', path, rel_path: relPath, offset: chunkOffset, length: chunkLength,
      source_is_dir: sourceIsDir, target_is_dir_hint: targetIsDirHint,
    }
    channel.send(p2pEnvelope(p2pMsgControl, new TextEncoder().encode(JSON.stringify(req)), keys.encryptKey))
    const ack = await waitForAck()
    if (!ack.ok) throw responseError(ack)

    let sent = 0
    while (sent < chunkLength) {
      if (signal.aborted) throw new Error('cancelled')
      const start = chunkOffset + sent
      const end = Math.min(start + P2P_MESSAGE_SIZE, chunkOffset + chunkLength)
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer())
      const envelope = p2pEnvelope(p2pMsgData, bytes, keys.encryptKey)

      while (channel.bufferedAmount + envelope.length > P2P_MAX_BUFFERED) {
        if (closedErr) throw closedErr
        await new Promise<void>((resolve) => { bufferedLowResolve = resolve })
      }
      channel.send(envelope)
      sent += bytes.length
      onSent(bytes.length)
    }

    const final = await waitForAck()
    if (!final.ok) throw responseError(final)
  }

  return { writeChunk, close: () => { try { channel.close() } catch { /* ignore */ } } }
}

// =========================== Relay (WebTransport) ===========================

// Buffers reads from a WebTransport stream so exact-length frames can be
// pulled out regardless of how the underlying reads happen to chunk.
// Exported: also used by shellStream.ts.
export class FrameReader {
  private buffer = new Uint8Array(0)
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(n: number): Promise<void> {
    while (this.buffer.length < n) {
      const { done, value } = await this.reader.read()
      if (done) throw new Error('stream closed unexpectedly')
      const combined = new Uint8Array(this.buffer.length + value.length)
      combined.set(this.buffer, 0)
      combined.set(value, this.buffer.length)
      this.buffer = combined
    }
  }

  async readFrame(): Promise<Uint8Array> {
    await this.fill(4)
    const length = decodeUint32BE(this.buffer)
    await this.fill(4 + length)
    const frame = this.buffer.slice(4, 4 + length)
    this.buffer = this.buffer.slice(4 + length)
    return frame
  }
}

function decodeUint32BE(bytes: Uint8Array): number {
  return (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0
}

function encodeFrame(data: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + data.length)
  framed[0] = (data.length >>> 24) & 0xff
  framed[1] = (data.length >>> 16) & 0xff
  framed[2] = (data.length >>> 8) & 0xff
  framed[3] = data.length & 0xff
  framed.set(data, 4)
  return framed
}

export type ByteWriter = WritableStreamDefaultWriter<Uint8Array>

export async function writeFrame(writer: ByteWriter, data: Uint8Array): Promise<void> {
  await writer.write(encodeFrame(data))
}

async function writeJSON(writer: ByteWriter, v: unknown): Promise<void> {
  await writeFrame(writer, new TextEncoder().encode(JSON.stringify(v)))
}

async function writeEncryptedJSON(writer: ByteWriter, v: unknown, key: Uint8Array): Promise<void> {
  await writeFrame(writer, encryptPayload(new TextEncoder().encode(JSON.stringify(v)), key))
}

async function readEncryptedJSON<T>(reader: FrameReader, key: Uint8Array): Promise<T> {
  const frame = await reader.readFrame()
  return JSON.parse(new TextDecoder().decode(decryptPayload(frame, key))) as T
}

// Mirrors quicClientKeyExchange in quictransfer.go, including the router's
// own plaintext error frame (device unreachable / bad realm) before the
// device is ever involved. Times out (rather than hanging forever) if the
// peer never replies — the caller wires its own abort signal to the raw
// stream around this call so a cancel actually unblocks the pending read.
async function webTransportKeyExchange(writer: ByteWriter, reader: FrameReader): Promise<EncryptionKeys> {
  const { publicKey, privateKey } = createX25519KeyPair()
  await writeJSON(writer, { public_key: bytesToBase64(publicKey) })

  const frame = await withTimeout(reader.readFrame(), HANDSHAKE_TIMEOUT_MS, 'timed out waiting for key exchange')
  const parsed = JSON.parse(new TextDecoder().decode(frame)) as { public_key?: string; error?: string }
  if (parsed.error) throw new Error(parsed.error)
  if (!parsed.public_key) throw new Error('invalid key exchange response')
  const serverPublicKey = base64ToBytes(parsed.public_key)
  if (serverPublicKey.length !== 32) throw new Error('invalid peer public key length')
  return deriveSessionKeys(privateKey, serverPublicKey)
}

export interface WebTransportStream {
  writer: ByteWriter
  reader: FrameReader
  raw: WebTransportBidirectionalStream
  keys: EncryptionKeys
}

// signal, if given, is wired to abort the raw stream only for the duration
// of this call (including the key exchange) — not the same as the caller's
// own longer-lived listener for the rest of the worker's life, which it
// still needs to register itself once this returns. Exported: also used by
// shellStream.ts, with op="shell" and an empty path (see fsOpShell in
// filetransfer.go — it doesn't carry an fsRequest, just routes the stream).
export async function openWebTransportStream(
  session: WampSession,
  realm: string,
  op: string,
  path: string,
  signal?: AbortSignal,
): Promise<WebTransportStream> {
  const raw = (await session.openStream()) as WebTransportBidirectionalStream
  if (signal?.aborted) {
    abortWebTransportStream(raw)
    throw new Error('cancelled')
  }
  const onAbort = () => abortWebTransportStream(raw)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const writer = raw.writable.getWriter()
    const rawReader = raw.readable.getReader()
    streamLocks.set(raw, { writer, reader: rawReader })
    const reader = new FrameReader(rawReader)
    await writeJSON(writer, { realm, op, path })
    const keys = await webTransportKeyExchange(writer, reader)
    return { writer, reader, raw, keys }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

// The writer and reader openWebTransportStream locked a stream's halves with: once
// locked, only they can abort/cancel them, raw.writable/raw.readable can't.
const streamLocks = new WeakMap<WebTransportBidirectionalStream, {
  writer: WritableStreamDefaultWriter<Uint8Array>
  reader: ReadableStreamDefaultReader<Uint8Array>
}>()

// Resets both halves, so the device stops sending: data left unread on an open stream
// holds the connection's flow-control window until no stream on it moves.
export function abortWebTransportStream(raw: WebTransportBidirectionalStream): void {
  const locks = streamLocks.get(raw)
  // These reject rather than throw, e.g. on a stream that already ended.
  void (locks ? locks.writer.abort() : raw.writable.abort()).catch(() => {})
  void (locks ? locks.reader.cancel() : raw.readable.cancel()).catch(() => {})
}

// One-shot request/response on its own stream — mirrors quicRequest in
// quictransfer.go. deskconn-router bridges a WebTransport stream to the same
// device-side QUIC stream handler a native QUIC client would use, so this
// speaks the identical wire protocol despite the browser-facing API being
// WebTransport rather than raw QUIC.
async function webTransportRequest(
  session: WampSession,
  realm: string,
  req: FSRequest,
  signal?: AbortSignal,
): Promise<FSResponse> {
  const { writer, reader, raw, keys } = await openWebTransportStream(session, realm, req.op, req.path ?? '', signal)
  try {
    await writeEncryptedJSON(writer, req, keys.encryptKey)
    const resp = await withTimeout(
      readEncryptedJSON<FSResponse>(reader, keys.decryptKey), HANDSHAKE_TIMEOUT_MS, 'timed out waiting for response',
    )
    if (!resp.ok) throw responseError(resp)
    return resp
  } finally {
    abortWebTransportStream(raw)
  }
}

// Single stream, single request, streaming the response straight to the
// caller as it arrives (via pull) rather than buffering the whole range
// before returning any of it) — one stream per download, matching the
// original working implementation.
async function webTransportReadRange(
  session: WampSession,
  realm: string,
  path: string,
  relPath: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<RangeResult> {
  const { writer, reader, raw, keys } = await openWebTransportStream(session, realm, 'read', path, signal)
  const onAbort = () => abortWebTransportStream(raw)
  signal?.addEventListener('abort', onAbort, { once: true })

  const req: FSRequest = { op: 'read', path, rel_path: relPath, offset, length }
  await writeEncryptedJSON(writer, req, keys.encryptKey)
  const ack = await withTimeout(
    readEncryptedJSON<FSResponse>(reader, keys.decryptKey), HANDSHAKE_TIMEOUT_MS, 'timed out waiting for response',
  )
  if (!ack.ok) { abortWebTransportStream(raw); throw responseError(ack) }

  let received = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) { controller.error(new Error('cancelled')); abortWebTransportStream(raw); return }
      const frame = await reader.readFrame()
      const plaintext = decryptPayload(frame, keys.decryptKey)
      received += plaintext.length
      controller.enqueue(plaintext)
      if (received >= length) {
        controller.close()
        abortWebTransportStream(raw)
        signal?.removeEventListener('abort', onAbort)
      }
    },
    cancel() {
      abortWebTransportStream(raw)
      signal?.removeEventListener('abort', onAbort)
    },
  })
  return { stream }
}

// Backs the parallel download path (large ranges only — see requestRange):
// opens one stream and keeps it for the lifetime of the worker, reusing it
// across every chunk that worker is assigned, mirroring quicReadWorker in
// quictransfer.go.
async function openWebTransportReadWorker(
  session: WampSession,
  realm: string,
  path: string,
  relPath: string,
  signal: AbortSignal,
): Promise<ChunkReadWorker> {
  const { writer, reader, raw, keys } = await openWebTransportStream(session, realm, 'read', path, signal)
  signal.addEventListener('abort', () => abortWebTransportStream(raw), { once: true })

  async function readChunk(offset: number, length: number, onData: (pieceOffset: number, data: Uint8Array) => void): Promise<void> {
    const req: FSRequest = { op: 'read', path, rel_path: relPath, offset, length }
    await writeEncryptedJSON(writer, req, keys.encryptKey)
    const ack = await readEncryptedJSON<FSResponse>(reader, keys.decryptKey)
    if (!ack.ok) throw responseError(ack)

    let received = 0
    let pos = offset
    while (received < length) {
      const frame = await reader.readFrame()
      const plaintext = decryptPayload(frame, keys.decryptKey)
      onData(pos, plaintext)
      pos += plaintext.length
      received += plaintext.length
    }
  }

  return { readChunk, close: () => abortWebTransportStream(raw) }
}

// Upload counterpart to webTransportReadRange: unlike downloads, uploads DO
// use the parallel chunk-worker pool (see the top-of-file comment for why)
// — this opens one stream and keeps it for the lifetime of the worker,
// reusing it across every chunk the worker is assigned. Mirrors
// quicWriteWorker in quictransfer.go.
async function openWebTransportWriteWorker(
  session: WampSession,
  realm: string,
  path: string,
  relPath: string,
  sourceIsDir: boolean,
  targetIsDirHint: boolean,
  file: Blob,
  signal: AbortSignal,
): Promise<ChunkWriteWorker> {
  const { writer, reader, raw, keys } = await openWebTransportStream(session, realm, 'write', path, signal)
  signal.addEventListener('abort', () => abortWebTransportStream(raw), { once: true })

  async function writeChunk(chunkOffset: number, chunkLength: number, onSent: (n: number) => void): Promise<void> {
    const req: FSRequest = {
      op: 'write', path, rel_path: relPath, offset: chunkOffset, length: chunkLength,
      source_is_dir: sourceIsDir, target_is_dir_hint: targetIsDirHint,
    }
    await writeEncryptedJSON(writer, req, keys.encryptKey)
    const ack = await readEncryptedJSON<FSResponse>(reader, keys.decryptKey)
    if (!ack.ok) throw responseError(ack)

    let sent = 0
    while (sent < chunkLength) {
      if (signal.aborted) throw new Error('cancelled')
      const start = chunkOffset + sent
      const end = Math.min(start + WEBTRANSPORT_MESSAGE_SIZE, chunkOffset + chunkLength)
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer())
      await writeFrame(writer, encryptPayload(bytes, keys.encryptKey))
      sent += bytes.length
      onSent(bytes.length)
    }

    const final = await readEncryptedJSON<FSResponse>(reader, keys.decryptKey)
    if (!final.ok) throw responseError(final)
  }

  return { writeChunk, close: () => abortWebTransportStream(raw) }
}

// encChunkSize on the Go side — the wire message size within one read/write
// request, not the parallel-worker job unit (PARALLEL_CHUNK_SIZE).
const WEBTRANSPORT_MESSAGE_SIZE = 64 * 1024
