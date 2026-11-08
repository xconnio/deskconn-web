import { AnonymousAuthenticator, CBORSerializer } from '@xconnio/core'
import { ClientConfig, connectTransport, connectWAMP } from '../src/services/xconn'
import { requestRange, uploadFile } from '../src/services/fileStream'
import { openShell } from '../src/services/shellStream'
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
      routed: true,
      webrtc: true,
    }
  } finally {
    await routed.close()
  }
}
