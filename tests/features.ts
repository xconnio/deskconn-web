import { AnonymousAuthenticator, CBORSerializer } from '@xconnio/xconn'
import { ClientConfig, connectTransport, connectWAMP } from '../src/services/xconn'
import { requestRange, uploadFile } from '../src/services/fileStream'
import { openShell } from '../src/services/shellStream'
import { openForward, startReverse } from '../src/services/portStream'
import type { WampSession } from '../src/services/wamp'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

async function bytes(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = stream.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

// Stands in for electron/main.js's socket side of a connection's MessagePort.
type Socket = { port: MessagePort; received: () => Uint8Array; closed: Promise<void> }
function fakeSocket(port: MessagePort, echo = false): Socket {
  const chunks: number[] = []
  let ended!: () => void
  const closed = new Promise<void>((resolve) => { ended = resolve })
  port.onmessage = ({ data }) => {
    if (ArrayBuffer.isView(data)) {
      const bytes = data as Uint8Array
      chunks.push(...bytes)
      port.postMessage({ type: 'ack', bytes: bytes.length })
      if (echo) sendChunked(port, bytes)
    } else if (data.type !== 'ack') ended()
  }
  return { port, received: () => Uint8Array.from(chunks), closed }
}

// Back-to-back 64 KiB messages, like a real socket's reads.
function sendChunked(port: MessagePort, payload: Uint8Array) {
  for (let i = 0; i < payload.length; i += 65536) port.postMessage(payload.slice(i, i + 65536))
}

async function until(condition: () => boolean, label: string) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 25))
  check(condition(), label)
}

async function ports(session: WampSession, fixture: Record<string, string>, label: string) {
  const payload = Uint8Array.from({ length: 4 * 1024 * 1024 }, (_, i) => i % 253)
  const forward = (remotePort: number) => {
    const { port1, port2 } = new MessageChannel()
    const local = fakeSocket(port1)
    return { local, done: openForward(session, fixture.realm!, remotePort, port2) }
  }

  // Forward to the runner's TCP echo server on the machine.
  const echo = forward(Number(fixture.echoPort))
  sendChunked(echo.local.port, payload)
  await until(() => echo.local.received().length === payload.length, `${label}: forward echo incomplete`)
  check(echo.local.received().every((v, i) => v === payload[i]), `${label}: forward echo changed bytes`)
  echo.local.port.postMessage({ type: 'end' })
  await echo.done

  let refused = false
  await forward(1).done.catch(() => { refused = true })
  check(refused, `${label}: forward to a closed port succeeded`)

  // Reverse: listen on the machine, then reach that listener through a forward.
  const remotePort = 40_000 + Math.floor(Math.random() * 20_000)
  const dialed: Socket[] = []
  let echoBack = true
  const reverse = await startReverse(session, fixture.realm!, remotePort, async () => {
    const { port1, port2 } = new MessageChannel()
    dialed.push(fakeSocket(port1, echoBack))
    return port2
  })
  try {
    const through = forward(remotePort)
    sendChunked(through.local.port, payload)
    await until(() => through.local.received().length === payload.length, `${label}: reverse echo incomplete`)
    check(through.local.received().every((v, i) => v === payload[i]), `${label}: reverse echo changed bytes`)
    through.local.port.postMessage({ type: 'end' })
    await through.done
    check(dialed.length === 1, `${label}: reverse dialed ${dialed.length} times`)
    await Promise.race([dialed[0]!.closed, new Promise((_, no) => setTimeout(() => no(new Error(`${label}: reverse conn not closed`)), 5000))])

    // Close straight after sending: every byte must still arrive before the close.
    echoBack = false
    const closing = forward(remotePort)
    sendChunked(closing.local.port, payload)
    closing.local.port.postMessage({ type: 'end' })
    await closing.done
    await until(() => dialed.length === 2, `${label}: close-after-send never dialed`)
    await Promise.race([dialed[1]!.closed, new Promise((_, no) => setTimeout(() => no(new Error(`${label}: close-after-send conn not closed`)), 15000))])
    const got = dialed[1]!.received()
    check(got.length === payload.length, `${label}: close-after-send lost bytes (${got.length}/${payload.length})`)
    check(got.every((v, i) => v === payload[i]), `${label}: close-after-send changed bytes`)
  } finally {
    reverse.stop()
  }
  await reverse.done
}

async function features(session: WampSession, fixture: Record<string, string>, label: string) {
  const sourceSize = 1_400_000
  const download = await requestRange(session, fixture.realm!, fixture.source!, 0, sourceSize)
  const downloaded = await bytes(download.stream)
  check(downloaded.length === sourceSize, `${label}: truncated download`)
  const pattern = [0, 255, 42, 128]
  check(
    downloaded.every((value, index) => value === pattern[index % 4]),
    `${label}: changed download bytes`,
  )

  const data = Uint8Array.from({ length: 5 * 1024 * 1024 + 123 }, (_, index) => index % 251)
  const filename = `${label}-upload.bin`
  await uploadFile(session, fixture.realm!, fixture.directory!, filename, new Blob([data]))
  const uploaded = await requestRange(
    session,
    fixture.realm!,
    `${fixture.directory}/${filename}`,
    0,
    data.length,
  )
  const received = await bytes(uploaded.stream)
  check(
    received.length === data.length && received.every((value, index) => value === data[index]),
    `${label}: changed upload bytes`,
  )

  const empty = await requestRange(session, fixture.realm!, fixture.source!, 0, 0)
  check((await bytes(empty.stream)).length === 0, `${label}: empty range did not finish`)
  let missing = false
  try {
    await requestRange(session, fixture.realm!, '/nonexistent-file', 0, 1)
  } catch {
    missing = true
  }
  check(missing, `${label}: missing file was accepted`)
  const cancelled = new AbortController()
  cancelled.abort()
  let aborted = false
  try {
    await requestRange(session, fixture.realm!, fixture.source!, 0, 1, cancelled.signal)
  } catch {
    aborted = true
  }
  check(aborted, `${label}: pre-cancelled read succeeded`)

  await Promise.all(
    ['first', 'second'].map(async (text) => {
      let output = ''
      let ended!: () => void
      const closed = new Promise<void>((resolve) => {
        ended = resolve
      })
      const shell = await openShell(
        session,
        fixture.realm!,
        80,
        24,
        (chunk) => {
          output += new TextDecoder().decode(chunk)
        },
        ended,
        undefined,
        { command: '/bin/sh', args: ['-c', `printf ${text}`] },
      )
      try {
        await closed
        check(output === text, `${label}: shell output changed: ${output}`)
      } finally {
        shell.close()
      }
    }),
  )
  await ports(session, fixture, label)
  check(session.isConnected(), `${label}: feature cleanup closed the session`)
}

export async function exercise(fixture: Record<string, string>) {
  const hash = Uint8Array.from(atob(fixture.hash!), (value) => value.charCodeAt(0))
  const routed = await connectTransport(
    fixture.webtransport!,
    fixture.realm!,
    new AnonymousAuthenticator(),
    [{ algorithm: 'sha-256', value: hash }],
  )
  try {
    await features(routed, fixture, 'routed')
    const [direct, rtc] = await connectWAMP(
      new ClientConfig(
        fixture.realm!,
        'offer',
        'to-provider',
        'to-client',
        new CBORSerializer(),
        new AnonymousAuthenticator(),
        routed,
        [],
      ),
    )
    try {
      await features(direct, fixture, 'direct')
    } finally {
      await direct.close()
      await rtc.connection.close()
    }
    check(routed.isConnected(), 'Closing direct session closed signaling')
    return {
      encryptedDownloads: true,
      encryptedUploads: true,
      concurrentShells: true,
      portForwarding: true,
      routed: true,
      webrtc: true,
    }
  } finally {
    await routed.close()
  }
}
