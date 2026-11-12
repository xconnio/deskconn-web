// Client side of deskconn's stream-based interactive shell protocol: one
// RPC-associated stream over WebRTC or WebTransport per terminal
// tab, reusing fileStream.ts's channel/stream opening and key-exchange
// helpers. Each message is a [kind_byte] + encryptPayload(...) envelope —
// kind 0 control JSON, kind 1 raw PTY data (see shellstream.go/
// shellclient.go for the server/CLI side).
//
// Not implemented: shellOpMigrate (the CLI's QUIC-then-direct live migration —
// the web app's transport is already fixed per session before any tab
// opens) and self-reported AuthID for agent forwarding (needs a local SSH
// agent, which a browser doesn't have).
import type { WampSession } from './wamp'
import {
  NoDirectConnectionError,
  encryptedEnvelope,
  openRPCFeatureStream,
  closeFeatureStream,
  writeFrame,
  type FrameReader,
} from './fileStream'
import { decryptPayload } from '@/utils/encryption'

const shellMsgControl = 0
const shellMsgData = 1

// Server drops a shell after ShellIdleTimeout (30s) without traffic; ping
// well under that so a quiet terminal isn't mistaken for a dead one.
const SHELL_PING_INTERVAL_MS = 10_000

/** Runs command (instead of the machine's interactive shell) in dir (instead of home). */
export interface ShellExec {
  command: string
  args?: string[]
  dir?: string
}

interface ShellControlMsg extends Partial<ShellExec> {
  op?: 'size' | 'ping'
  cols?: number
  rows?: number
  shell_id?: string
  token?: string
}

export interface ShellHandle {
  shellId: string
  send(bytes: Uint8Array): void
  resize(cols: number, rows: number): void
  close(): void
}

export async function openShell(
  session: WampSession,
  realm: string,
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onClose: () => void,
  signal?: AbortSignal,
  exec?: ShellExec,
): Promise<ShellHandle> {
  if (typeof session?.openRPCStream === 'function') return openStreamShell(session, realm, cols, rows, onData, onClose, signal, exec)
  throw new NoDirectConnectionError()
}

function encodeControl(msg: ShellControlMsg, key: Uint8Array): Uint8Array<ArrayBuffer> {
  return encryptedEnvelope(shellMsgControl, new TextEncoder().encode(JSON.stringify(msg)), key)
}

function decryptShellFrame(frame: Uint8Array, key: Uint8Array): { kind: number; plaintext: Uint8Array } {
  const kind = frame[0]
  if (kind === undefined) throw new Error('empty message')
  return { kind, plaintext: decryptPayload(frame.slice(1), key) }
}

async function readShellAck(reader: FrameReader, key: Uint8Array): Promise<ShellControlMsg> {
  const frame = await reader.readFrame()
  const { kind, plaintext } = decryptShellFrame(frame, key)
  if (kind !== shellMsgControl) throw new Error('unexpected shell response')
  return JSON.parse(new TextDecoder().decode(plaintext)) as ShellControlMsg
}

async function openStreamShell(
  session: WampSession,
  realm: string,
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onClose: () => void,
  signal?: AbortSignal,
  exec?: ShellExec,
): Promise<ShellHandle> {
  const { writer, reader, raw, keys } = await openRPCFeatureStream(session, realm, 'shell', signal)
  const onAbort = () => closeFeatureStream(raw)
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await writeFrame(writer, encodeControl({ op: 'size', cols, rows, ...exec }, keys.encryptKey))
    const ack = await readShellAck(reader, keys.decryptKey)
    const pingTimer = setInterval(() => {
      void writeFrame(writer, encodeControl({ op: 'ping' }, keys.encryptKey)).catch(() => { /* ignore */ })
    }, SHELL_PING_INTERVAL_MS)

    void (async () => {
      try {
        while (true) {
          const frame = await reader.readFrame()
          let kind: number, plaintext: Uint8Array
          try { ({ kind, plaintext } = decryptShellFrame(frame, keys.decryptKey)) }
          catch { continue }
          if (kind === shellMsgData) onData(plaintext)
        }
      } catch {
        onClose()
      } finally {
        clearInterval(pingTimer)
        signal?.removeEventListener('abort', onAbort)
      }
    })()

    return {
      shellId: ack.shell_id ?? '',
      send: (bytes) => { void writeFrame(writer, encryptedEnvelope(shellMsgData, bytes, keys.encryptKey)).catch(() => { /* ignore */ }) },
      resize: (c, r) => { void writeFrame(writer, encodeControl({ op: 'size', cols: c, rows: r }, keys.encryptKey)).catch(() => { /* ignore */ }) },
      close: () => closeFeatureStream(raw),
    }
  } catch (err) {
    signal?.removeEventListener('abort', onAbort)
    closeFeatureStream(raw)
    throw err
  }
}
