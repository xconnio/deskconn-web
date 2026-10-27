import { reactive } from 'vue'
import { AnonymousAuthenticator, CBORSerializer, Result } from '@xconnio/core'
import { ClientConfig, connectTransport, connectWAMP } from '../src/services/xconn'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export async function exercise(server: Record<string, string>) {
  const cert = Uint8Array.from(server.webtransport_certificate!.match(/../g)!, (hex) =>
    parseInt(hex, 16),
  )
  const hash = await crypto.subtle.digest('SHA-256', cert)
  const routed = await connectTransport(
    server.webtransport!,
    'realm',
    new AnonymousAuthenticator(),
    [{ algorithm: 'sha-256', value: hash }],
  )
  check(reactive({ session: routed }).session === routed, 'Vue proxied a native transport owner')
  let stage = 'routed RPC'
  try {
    check(
      (await routed.call('echo', ['hello'], { binary: new Uint8Array([0, 255]) })).args[0] ===
        'hello',
      'RPC arguments changed',
    )
    stage = 'child session'
    const child = await routed.openSession('realm', new AnonymousAuthenticator())
    await child.leave()
    check(routed.isConnected(), 'Closing a child closed the shared connection')

    stage = 'relay stream'
    const stream = await routed.openStream()
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    stage = 'relay write'
    await writer.write(new Uint8Array([0, 255, 42]))
    stage = 'relay read'
    const reply = await reader.read()
    check(reply.value?.join() === '0,255,42', 'Relay bytes changed')
    // DeskConn ends its shell/file record protocols by canceling the stream.
    await reader.cancel()
    await writer.abort()
    reader.releaseLock()
    writer.releaseLock()

    const observer = await routed.openSession('realm', new AnonymousAuthenticator())
    let clientCandidates = 0
    let serverCandidates = 0
    const outbound = await observer.native
      .subscribe('to-provider', () => {
        clientCandidates++
      })
      .execute()
    const inbound = await observer.native
      .subscribe('to-client', () => {
        serverCandidates++
      })
      .execute()
    stage = 'WebRTC connect'
    const [direct, rtc] = await connectWAMP(
      new ClientConfig(
        'realm',
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
      check((await direct.call('echo', [42])).args[0] === 42, 'Direct RPC failed')
      check(
        clientCandidates > 0 && serverCandidates > 0,
        'Legacy ICE topic directions were reversed',
      )
      stage = 'progressive RPC'
      const registration = await direct.native
        .register('app.progress', async (invocation) => {
          await invocation.sendProgress(['first'])
          await invocation.sendProgress(['second'])
          return new Result(['done'])
        })
        .execute()
      try {
        const call = await routed.callProgress('app.progress')
        const chunks: unknown[] = []
        call.registerProgress((value) => chunks.push(value.args[0]))
        check((await call.finalResultPromise).args[0] === 'done', 'Progressive final result lost')
        check(chunks.join() === 'first,second', 'Progressive chunks reordered')
      } finally {
        await registration.unregister()
      }

      stage = 'raw channel'
      const channel = await rtc.openDataChannel('packets')
      try {
        const message = new Promise<MessageEvent>((resolve) =>
          channel.addEventListener('message', resolve),
        )
        channel.send('{"public_key":"test"}')
        check((await message).data === '{"public_key":"test"}', 'Text key-exchange packet changed')
        const binary = new Promise<MessageEvent>((resolve) =>
          channel.addEventListener('message', resolve),
        )
        const data = new Uint8Array(65024).fill(127)
        channel.send(data)
        await channel.waitBufferedBelow(0)
        const received = new Uint8Array((await binary).data)
        check(
          received.length === data.length && received.every((value) => value === 127),
          'Raw encrypted envelope changed',
        )
      } finally {
        channel.close()
      }
    } finally {
      await direct.leave()
      await outbound.unsubscribe()
      await inbound.unsubscribe()
      await observer.leave()
    }
    check(routed.isConnected(), 'Direct cleanup closed borrowed signaling')
    return { rpc: true, relay: true, webrtc: true, progressiveResults: true }
  } catch (error) {
    throw new Error(`${stage}: ${String(error)}`, { cause: error })
  } finally {
    await routed.leave()
  }
}
