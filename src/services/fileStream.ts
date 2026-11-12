// Encrypted file transfers over RPC-associated byte streams. WAMP authorizes
// each operation; XConn selects the direct or routed stream carrier.
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


export class NoDirectConnectionError extends Error {
  constructor() {
    super('No connection to this device')
    this.name = 'NoDirectConnectionError'
  }
}

// Both direct and routed sessions expose the same RPC-associated streams.
export function canStreamRanges(session: WampSession | null | undefined): boolean {
  if (!session) return false
  return typeof session.openRPCStream === 'function'
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

// Bound setup so a lost handshake cannot leave an operation waiting forever.
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
// size (see DIRECT_MESSAGE_SIZE/STREAM_MESSAGE_SIZE below for that).

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
  if (!canStreamRanges(session)) throw new NoDirectConnectionError()

  const relPath = baseName(path)
  return streamReadRange(session, realm, path, relPath, offset, length, signal)
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
  if (!canStreamRanges(session)) throw new NoDirectConnectionError()

  const relPath = baseName(path)
  const chunks = planChunks(offset, length)
  if (chunks.length <= 1) return requestRangeStream(session, realm, path, offset, length, signal)

  return readRangeParallel(
    chunks, offset, length,
    (s) => openReadWorker(session, realm, path, relPath, s),
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
  if (!canStreamRanges(session)) throw new NoDirectConnectionError()

  const initReq: FSRequest = {
    op: 'init',
    path: destDir,
    entries: [{ rel_path: fileName, size: file.size, mode: 0, is_dir: false }],
    source_is_dir: false,
    target_is_dir_hint: true,
  }
  await streamRequest(session, realm, initReq, signal)

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
    const worker = await openWriteWorker(session, realm, destDir, fileName, false, true, file, abort.signal)
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

// ============================= Direct (WebRTC) =============================

export function encryptedEnvelope(kind: number, plaintext: Uint8Array, key: Uint8Array): Uint8Array<ArrayBuffer> {
  const ciphertext = encryptPayload(plaintext, key)
  const envelope = new Uint8Array(1 + ciphertext.length)
  envelope[0] = kind
  envelope.set(ciphertext, 1)
  return envelope
}

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
    if (length > 16 * 1024 * 1024) throw new Error('Feature frame exceeds 16 MiB')
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

// Per-stream encryption is unchanged; routing is authorized by the RPC.
async function streamKeyExchange(writer: ByteWriter, reader: FrameReader): Promise<EncryptionKeys> {
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

export interface RPCFeatureStream {
  writer: ByteWriter
  reader: FrameReader
  raw: ReadableWritablePair<Uint8Array, Uint8Array>
  keys: EncryptionKeys
}

// Abort covers setup; workers retain their own listener for the operation lifetime.
export async function openRPCFeatureStream(
  session: WampSession,
  realm: string,
  op: string,
  signal?: AbortSignal,
): Promise<RPCFeatureStream> {
  if (session.realm() !== realm) throw new Error('Stream realm does not match the WAMP session')
  if (signal?.aborted) throw new Error('cancelled')
  const procedure = op === 'shell' ? 'io.xconn.deskconn.shell.stream' : `io.xconn.deskconn.file.stream.${op}`
  const raw = await session.openRPCStream(procedure, op === 'init' || op === 'write')
  if (signal?.aborted) {
    closeFeatureStream(raw)
    throw new Error('cancelled')
  }
  const onAbort = () => closeFeatureStream(raw)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const writer = raw.writable.getWriter()
    const rawReader = raw.readable.getReader()
    streamLocks.set(raw, { writer, reader: rawReader })
    const reader = new FrameReader(rawReader)
    const keys = await streamKeyExchange(writer, reader)
    return { writer, reader, raw, keys }
  } catch (error) {
    closeFeatureStream(raw)
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

// The writer and reader openRPCFeatureStream locked a stream's halves with: once
// locked, only they can abort/cancel them, raw.writable/raw.readable can't.
const streamLocks = new WeakMap<ReadableWritablePair<Uint8Array, Uint8Array>, {
  writer: WritableStreamDefaultWriter<Uint8Array>
  reader: ReadableStreamDefaultReader<Uint8Array>
}>()

// Resets both halves, so the device stops sending: data left unread on an open stream
// holds the connection's flow-control window until no stream on it moves.
export function closeFeatureStream(raw: ReadableWritablePair<Uint8Array, Uint8Array>): void {
  const locks = streamLocks.get(raw)
  // These reject rather than throw, e.g. on a stream that already ended.
  void (locks ? locks.writer.abort() : raw.writable.abort()).catch(() => {})
  void (locks ? locks.reader.cancel() : raw.readable.cancel()).catch(() => {})
}

// One authorized RPC stream per one-shot file operation.
async function streamRequest(
  session: WampSession,
  realm: string,
  req: FSRequest,
  signal?: AbortSignal,
): Promise<FSResponse> {
  const { writer, reader, raw, keys } = await openRPCFeatureStream(session, realm, req.op, signal)
  try {
    await writeEncryptedJSON(writer, req, keys.encryptKey)
    const resp = await withTimeout(
      readEncryptedJSON<FSResponse>(reader, keys.decryptKey), HANDSHAKE_TIMEOUT_MS, 'timed out waiting for response',
    )
    if (!resp.ok) throw responseError(resp)
    return resp
  } finally {
    closeFeatureStream(raw)
  }
}

// Single stream, single request, streaming the response straight to the
// caller as it arrives (via pull) rather than buffering the whole range
// before returning any of it) — one stream per download, matching the
// original working implementation.
async function streamReadRange(
  session: WampSession,
  realm: string,
  path: string,
  relPath: string,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<RangeResult> {
  const { writer, reader, raw, keys } = await openRPCFeatureStream(session, realm, 'read', signal)
  const onAbort = () => closeFeatureStream(raw)
  signal?.addEventListener('abort', onAbort, { once: true })

  const close = () => {
    closeFeatureStream(raw)
    signal?.removeEventListener('abort', onAbort)
  }
  try {
    const req: FSRequest = { op: 'read', path, rel_path: relPath, offset, length }
    await writeEncryptedJSON(writer, req, keys.encryptKey)
    const ack = await withTimeout(
      readEncryptedJSON<FSResponse>(reader, keys.decryptKey), HANDSHAKE_TIMEOUT_MS, 'timed out waiting for response',
    )
    if (!ack.ok) throw responseError(ack)
  } catch (error) {
    close()
    throw error
  }

  let received = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (signal?.aborted) throw new Error('cancelled')
        if (received < length) {
          const plaintext = decryptPayload(await reader.readFrame(), keys.decryptKey)
          if (plaintext.length === 0 || plaintext.length > length - received) throw new Error('Invalid file stream chunk length')
          received += plaintext.length
          controller.enqueue(plaintext)
        }
        if (received === length) {
          controller.close()
          close()
        }
      } catch (error) {
        controller.error(error)
        close()
      }
    },
    cancel: close,
  })
  return { stream }
}

// Backs the parallel download path (large ranges only — see requestRange):
// opens one stream and keeps it for the lifetime of the worker, reusing it
// across every chunk that worker is assigned, mirroring quicReadWorker in
// quictransfer.go.
async function openReadWorker(
  session: WampSession,
  realm: string,
  path: string,
  relPath: string,
  signal: AbortSignal,
): Promise<ChunkReadWorker> {
  const { writer, reader, raw, keys } = await openRPCFeatureStream(session, realm, 'read', signal)
  signal.addEventListener('abort', () => closeFeatureStream(raw), { once: true })

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

  return { readChunk, close: () => closeFeatureStream(raw) }
}

// Upload counterpart to streamReadRange: unlike downloads, uploads DO
// use the parallel chunk-worker pool (see the top-of-file comment for why)
// — this opens one stream and keeps it for the lifetime of the worker,
// reusing it across every chunk the worker is assigned. Mirrors
// quicWriteWorker in quictransfer.go.
async function openWriteWorker(
  session: WampSession,
  realm: string,
  path: string,
  relPath: string,
  sourceIsDir: boolean,
  targetIsDirHint: boolean,
  file: Blob,
  signal: AbortSignal,
): Promise<ChunkWriteWorker> {
  const { writer, reader, raw, keys } = await openRPCFeatureStream(session, realm, 'write', signal)
  signal.addEventListener('abort', () => closeFeatureStream(raw), { once: true })

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
      const end = Math.min(start + STREAM_MESSAGE_SIZE, chunkOffset + chunkLength)
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer())
      await writeFrame(writer, encryptPayload(bytes, keys.encryptKey))
      sent += bytes.length
      onSent(bytes.length)
    }

    const final = await readEncryptedJSON<FSResponse>(reader, keys.decryptKey)
    if (!final.ok) throw responseError(final)
  }

  return { writeChunk, close: () => closeFeatureStream(raw) }
}

// encChunkSize on the Go side — the wire message size within one read/write
// request, not the parallel-worker job unit (PARALLEL_CHUNK_SIZE).
const STREAM_MESSAGE_SIZE = 64 * 1024
