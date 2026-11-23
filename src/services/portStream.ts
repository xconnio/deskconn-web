// Client side of deskconn's port forwarding (see deskconn's
// internal/common/portstream.go and internal/userd/portstream.go):
//
// - forward: one RPC-associated stream per local TCP connection. Send
//   {port}, wait for the ack, then relay kind-1 data frames both ways.
// - reverse: one stream per rule. Send {op:"listen"}; the machine then sends
//   connect/close events and data tagged with an 8-byte conn_id for every
//   connection it accepts, and we dial the local target for each.
//
// The page can't open sockets, so each local TCP connection is a MessagePort
// whose other end is the socket in electron/main.js (PortMessage below).
import type { WampSession } from './wamp'
import {
  closeFeatureStream,
  encryptedEnvelope,
  openRPCFeatureStream,
  writeFrame,
  type ByteWriter,
  type FrameReader,
} from './fileStream'
import { decryptPayload } from '@/utils/encryption'

const MSG_CONTROL = 0
const MSG_DATA = 1
// The daemon drops a stream after 30 s of silence.
const PING_INTERVAL_MS = 10_000
const CHUNK_SIZE = 32 * 1024
/** How long a closed connection's last bytes get to reach the machine. */
const FLUSH_TIMEOUT_MS = 10_000
/** Bytes posted to a port and not yet acked before we stop reading the stream. Mirrors electron/main.js. */
const PORT_WINDOW = 1024 * 1024

/** What travels on a connection's MessagePort, in both directions. */
type PortMessage = Uint8Array | { type: 'ack'; bytes: number } | { type: 'end' } | { type: 'error'; message: string }

function control(msg: object, key: Uint8Array): Uint8Array {
  return encryptedEnvelope(MSG_CONTROL, new TextEncoder().encode(JSON.stringify(msg)), key)
}

function decodeFrame(frame: Uint8Array, key: Uint8Array): { kind: number; plaintext: Uint8Array } | null {
  try {
    return { kind: frame[0] ?? -1, plaintext: decryptPayload(frame.slice(1), key) }
  } catch {
    return null
  }
}

async function readControl<T>(reader: FrameReader, key: Uint8Array): Promise<T> {
  for (;;) {
    const decoded = decodeFrame(await reader.readFrame(), key)
    if (decoded?.kind === MSG_CONTROL) return JSON.parse(new TextDecoder().decode(decoded.plaintext)) as T
  }
}

// Not async between frames: every frame is queued on the writer before returning, so
// the frames of back-to-back calls (one per socket read) can't interleave.
function writeData(writer: ByteWriter, bytes: Uint8Array, key: Uint8Array, tag?: number): Promise<void> {
  const writes: Promise<void>[] = []
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE)
    let payload = chunk
    if (tag !== undefined) {
      payload = new Uint8Array(8 + chunk.length)
      new DataView(payload.buffer).setBigUint64(0, BigInt(tag))
      payload.set(chunk, 8)
    }
    writes.push(writeFrame(writer, encryptedEnvelope(MSG_DATA, payload, key)))
  }
  return Promise.all(writes).then(() => {})
}

function endPort(port: MessagePort, err?: unknown): void {
  port.postMessage(err ? { type: 'error', message: err instanceof Error ? err.message : String(err) } : { type: 'end' })
  port.close()
}

/** One local TCP connection, with flow control for bytes we post to it. */
class LocalConn {
  private inflight = 0
  private wake: (() => void) | null = null
  private ended = false

  constructor(
    private readonly port: MessagePort,
    onData: (bytes: Uint8Array) => void,
    private readonly onEnd: () => void,
  ) {
    port.onmessage = ({ data }: MessageEvent<PortMessage>) => {
      if (ArrayBuffer.isView(data)) onData(data)
      else if (data.type === 'ack') {
        this.inflight -= data.bytes
        if (this.inflight <= PORT_WINDOW) this.resume()
      } else this.finish(true)
    }
  }

  /** Posts bytes to the socket; resolves once it has room for more. */
  async send(bytes: Uint8Array): Promise<void> {
    if (this.ended) return
    this.inflight += bytes.length
    this.port.postMessage(bytes)
    while (this.inflight > PORT_WINDOW && !this.ended) await new Promise<void>((resolve) => { this.wake = resolve })
  }

  /** Tells the socket `bytes` it sent have reached the stream. */
  ack(bytes: number): void {
    if (!this.ended) this.port.postMessage({ type: 'ack', bytes })
  }

  /** Closes the socket from this side. */
  end(): void {
    if (this.ended) return
    this.finish(false)
    endPort(this.port)
  }

  private finish(remote: boolean): void {
    if (this.ended) return
    this.ended = true
    this.resume()
    if (remote) {
      this.port.close()
      this.onEnd()
    }
  }

  private resume(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

/**
 * Relays one accepted local connection to localhost:remotePort on the machine.
 * Rejects (and closes `port`) if the stream or the machine's dial fails;
 * otherwise resolves once either side closes.
 */
export async function openForward(session: WampSession, realm: string, remotePort: number, port: MessagePort): Promise<void> {
  let stream
  try {
    stream = await openRPCFeatureStream(session, realm, 'portforward')
  } catch (err) {
    endPort(port, err)
    throw err
  }
  const { writer, reader, raw, keys } = stream
  try {
    await writeFrame(writer, control({ port: String(remotePort) }, keys.encryptKey))
    const ack = await readControl<{ error?: string }>(reader, keys.decryptKey)
    if (ack.error) throw new Error(ack.error)
  } catch (err) {
    closeFeatureStream(raw)
    endPort(port, err)
    throw err
  }

  return new Promise<void>((resolve) => {
    let finished = false
    let lastWrite: Promise<void> = Promise.resolve()
    // graceful: the local client closed, so its last bytes may still be queued on the
    // stream. Aborting would discard them; close the writer once they're written instead.
    const finish = (graceful = false) => {
      if (finished) return
      finished = true
      clearInterval(ping)
      conn.end()
      const flushed = graceful
        ? Promise.race([lastWrite.then(() => writer.close()), new Promise((r) => setTimeout(r, FLUSH_TIMEOUT_MS))])
        : Promise.resolve()
      void flushed.catch(() => {}).finally(() => closeFeatureStream(raw))
      resolve()
    }
    const ping = setInterval(() => {
      writeFrame(writer, control({}, keys.encryptKey)).catch(() => finish())
    }, PING_INTERVAL_MS)
    // WritableStream queues writes in call order, so these needn't be awaited in turn.
    const conn = new LocalConn(
      port,
      (bytes) => {
        lastWrite = writeData(writer, bytes, keys.encryptKey)
        lastWrite.then(() => conn.ack(bytes.length), () => finish())
      },
      () => finish(true),
    )
    void (async () => {
      try {
        for (;;) {
          const decoded = decodeFrame(await reader.readFrame(), keys.decryptKey)
          if (decoded?.kind === MSG_DATA) await conn.send(decoded.plaintext)
          // Control frames here are pings.
        }
      } catch {
        // Stream ended.
      } finally {
        finish()
      }
    })()
  })
}

interface ReverseHandle {
  stop(): void
  /** Resolves once the session stream ends, for any reason. */
  done: Promise<void>
}

/**
 * Listens on remotePort on the machine and relays each connection it accepts
 * to a local socket from `dial`. Rejects if the machine can't listen.
 */
export async function startReverse(
  session: WampSession,
  realm: string,
  remotePort: number,
  dial: () => Promise<MessagePort>,
  onConnections?: (count: number) => void,
): Promise<ReverseHandle> {
  const { writer, reader, raw, keys } = await openRPCFeatureStream(session, realm, 'portreverse')
  try {
    await writeFrame(writer, control({ op: 'listen', remote_port: String(remotePort) }, keys.encryptKey))
    const ack = await readControl<{ op?: string; error?: string }>(reader, keys.decryptKey)
    if (ack.error) throw new Error(ack.error)
  } catch (err) {
    closeFeatureStream(raw)
    throw err
  }

  // A connection's data can arrive while its local dial is still in flight: queue it.
  const conns = new Map<number, { conn: LocalConn | null; queue: Uint8Array[] }>()
  let finished = false
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => { resolveDone = resolve })

  const finish = () => {
    if (finished) return
    finished = true
    clearInterval(ping)
    for (const id of [...conns.keys()]) closeConn(id, false)
    closeFeatureStream(raw)
    resolveDone()
  }
  const ping = setInterval(() => {
    writeFrame(writer, control({}, keys.encryptKey)).catch(finish)
  }, PING_INTERVAL_MS)

  function closeConn(id: number, tellMachine: boolean) {
    const entry = conns.get(id)
    if (!entry) return
    conns.delete(id)
    entry.conn?.end()
    if (tellMachine && !finished) writeFrame(writer, control({ op: 'close', conn_id: id }, keys.encryptKey)).catch(finish)
    onConnections?.(conns.size)
  }

  function connect(id: number) {
    const entry: { conn: LocalConn | null; queue: Uint8Array[] } = { conn: null, queue: [] }
    conns.set(id, entry)
    onConnections?.(conns.size)
    dial().then(
      (port) => {
        if (conns.get(id) !== entry) return endPort(port)
        const conn = new LocalConn(
          port,
          (bytes) => {
            writeData(writer, bytes, keys.encryptKey, id).then(() => conn.ack(bytes.length), finish)
          },
          () => closeConn(id, true),
        )
        entry.conn = conn
        for (const bytes of entry.queue) void conn.send(bytes)
        entry.queue = []
      },
      () => closeConn(id, true),
    )
  }

  void (async () => {
    try {
      for (;;) {
        const decoded = decodeFrame(await reader.readFrame(), keys.decryptKey)
        if (!decoded) continue
        if (decoded.kind === MSG_CONTROL) {
          const msg = JSON.parse(new TextDecoder().decode(decoded.plaintext)) as { op?: string; conn_id?: number }
          if (msg.op === 'connect' && msg.conn_id !== undefined) connect(msg.conn_id)
          else if (msg.op === 'close' && msg.conn_id !== undefined) closeConn(msg.conn_id, false)
        } else if (decoded.kind === MSG_DATA && decoded.plaintext.length >= 8) {
          const view = new DataView(decoded.plaintext.buffer, decoded.plaintext.byteOffset, 8)
          const entry = conns.get(Number(view.getBigUint64(0)))
          const bytes = decoded.plaintext.slice(8)
          // ponytail: one slow local socket stalls every connection on this rule (they share one stream).
          if (entry?.conn) await entry.conn.send(bytes)
          else entry?.queue.push(bytes)
        }
      }
    } catch {
      // Stream ended.
    } finally {
      finish()
    }
  })()

  return { stop: finish, done }
}

// ── Desktop bridge (electron/preload.cjs) ──

interface DesktopPortsBridge {
  listen(port: number): Promise<string>
  close(id: string): Promise<void>
  dial(requestId: string, port: number): void
}

const bridge = (globalThis as { deskconnPorts?: DesktopPortsBridge }).deskconnPorts

/** Only the desktop app can open local sockets. */
export const portForwardingAvailable = bridge !== undefined

const listeners = new Map<string, (port: MessagePort) => void>()
const dials = new Map<string, { resolve: (port: MessagePort) => void; reject: (err: Error) => void }>()

if (bridge) {
  // contextBridge can't carry MessagePorts, so the preload relays them here.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data as { deskconnPorts?: string; id?: string; requestId?: string; error?: string } | null
    const port = event.ports[0]
    if (data?.deskconnPorts === 'conn' && port) {
      const onConnection = data.id ? listeners.get(data.id) : undefined
      if (onConnection) onConnection(port)
      else endPort(port)
    } else if (data?.deskconnPorts === 'dialed' && data.requestId) {
      const waiter = dials.get(data.requestId)
      dials.delete(data.requestId)
      if (!waiter) {
        if (port) endPort(port)
      } else if (data.error || !port) waiter.reject(new Error(data.error ?? 'dial failed'))
      else waiter.resolve(port)
    }
  })
}

// ipcRenderer.invoke wraps errors as "Error invoking remote method 'x': Error: <message>".
function bridgeError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  return new Error(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
}

/** Listens on 127.0.0.1:localPort; returns the function that stops listening. */
export async function listenLocal(localPort: number, onConnection: (port: MessagePort) => void): Promise<() => Promise<void>> {
  if (!bridge) throw new Error('Port forwarding needs the DeskConn desktop app')
  let id: string
  try {
    id = await bridge.listen(localPort)
  } catch (err) {
    throw bridgeError(err)
  }
  listeners.set(id, onConnection)
  return async () => {
    listeners.delete(id)
    await bridge.close(id).catch(() => {})
  }
}

/** Connects to 127.0.0.1:localPort. */
export function dialLocal(localPort: number): Promise<MessagePort> {
  if (!bridge) return Promise.reject(new Error('Port forwarding needs the DeskConn desktop app'))
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    dials.set(requestId, { resolve, reject })
    bridge.dial(requestId, localPort)
  })
}
