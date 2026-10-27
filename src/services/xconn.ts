/** App transport ownership and compatibility with DeskConn's RPC call sites. */
import { markRaw, type Raw } from 'vue'
import {
  CBORSerializer,
  CryptoSignAuthenticator,
  WAMPCRAAuthenticator,
  WebTransportConnection,
  WebRTCConnection,
  type Session as CoreSession,
  type DataChannel,
  type ClientAuthenticator,
  type Serializer,
  type Result,
} from '@xconnio/core'
export {
  ApplicationError,
  CBORSerializer,
  CryptoSignAuthenticator,
  WAMPCRAAuthenticator,
} from '@xconnio/core'
export type { ClientAuthenticator } from '@xconnio/core'
export type WebTransportCertHash = WebTransportHash

type Dictionary = Record<string, unknown>

export type Session = Pick<OwnedSession, keyof OwnedSession>

class OwnedSession {
  constructor(
    native: CoreSession,
    private readonly transport?: WebTransportConnection,
    private readonly release?: () => Promise<void>,
  ) {
    markRaw(this)
    this.native = markRaw(native)
    if (release) {
      native.onDisconnect(() => {
        void this.leave().catch(() => {})
      })
    }
  }

  readonly native: Raw<CoreSession>
  private closing?: Promise<void>

  call(uri: string, args: unknown[] = [], kwargs: Dictionary = {}, options: Dictionary = {}) {
    return this.native
      .call(uri)
      .args(...args)
      .kwargs(kwargs)
      .options(options)
      .execute()
  }

  async callProgress(uri: string, args: unknown[] = [], kwargs: Dictionary = {}) {
    const call = await this.native
      .call(uri)
      .args(...args)
      .kwargs(kwargs)
      .stream()
    let receiver: ((result: Result) => void) | undefined
    const buffered: Result[] = []
    const finalResultPromise = (async () => {
      for await (const result of call.results()) {
        if (!result.progress) return result
        if (receiver) receiver(result)
        else {
          if (buffered.length >= 32) throw new Error('Progress callback was not attached')
          buffered.push(result)
        }
      }
      throw new Error('Progressive call ended without a result')
    })()
    void finalResultPromise.catch(() => {})
    return {
      finalResultPromise,
      registerProgress(callback: (result: Result) => void) {
        receiver = callback
        for (const result of buffered.splice(0)) callback(result)
      },
      cancel: () => call.close(),
    }
  }

  isConnected() {
    return this.native.isConnected()
  }

  onDisconnect(callback: (reason: string) => void | Promise<void>) {
    this.native.onDisconnect((reason) => callback(reason ?? 'Connection closed'))
  }

  leave(): Promise<void> {
    return (this.closing ??= (async () => {
      try {
        await this.native.close()
      } finally {
        await this.release?.()
      }
    })())
  }

  close() {
    return this.leave()
  }

  id() {
    return this.native.details.sessionID
  }

  realm() {
    return this.native.details.realm
  }

  authid() {
    return this.native.details.authid
  }

  getSessionDetails() {
    return this.native.details
  }

  async openSession(realm: string, authenticator: ClientAuthenticator) {
    if (!this.transport) throw new Error('This session does not support additional relay sessions')
    return new OwnedSession(
      await this.transport.openSession(realm, { authenticator, serializer: new CBORSerializer() }),
      this.transport,
    )
  }

  async openStream(): Promise<WebTransportBidirectionalStream> {
    if (!this.transport) throw new Error('This session does not support relay streams')
    const stream = await this.transport.openStream()
    return {
      readable: new ReadableStream<Uint8Array>({
        async pull(controller) {
          const value = await stream.read()
          if (value === undefined) controller.close()
          else controller.enqueue(value)
        },
        cancel: () => stream.close(),
      }),
      writable: new WritableStream<Uint8Array>({
        write: (data) => stream.write(data),
        close: () => stream.writeEof(),
        abort: () => stream.close(),
      }),
    }
  }
}

export async function connectTransport(
  url: string,
  realm: string,
  authenticator: ClientAuthenticator,
  hashes?: WebTransportCertHash[],
) {
  const transport = await WebTransportConnection.connect(url, { serverCertificateHashes: hashes })
  try {
    const session = await transport.openSession(realm, {
      authenticator,
      serializer: new CBORSerializer(),
    })
    return new OwnedSession(session, transport, () => transport.close())
  } catch (error) {
    await transport.close()
    throw error
  }
}

export function connectWebTransportCRA(
  url: string,
  realm: string,
  authId: string,
  secret: string,
  hashes?: WebTransportCertHash[],
) {
  return connectTransport(url, realm, new WAMPCRAAuthenticator(authId, secret), hashes)
}

export function connectWebTransportCryptosign(
  url: string,
  realm: string,
  authId: string,
  key: string,
  hashes?: WebTransportCertHash[],
) {
  return connectTransport(url, realm, new CryptoSignAuthenticator(authId, key), hashes)
}

export class ClientConfig {
  constructor(
    readonly realm: string,
    readonly offerProcedure: string,
    // Topics name the candidate receiver: answerer, then offerer.
    readonly localCandidatesTopic: string,
    readonly remoteCandidatesTopic: string,
    readonly serializer: Serializer,
    readonly authenticator: ClientAuthenticator,
    readonly session: Session,
    readonly iceServers: RTCIceServer[],
  ) {}
}

/** DOM event adapter for the app's encrypted raw-channel protocols. */
export class DirectChannel extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  private closed = false

  constructor(private readonly channel: DataChannel) {
    super()
    channel.onDisconnect(() => this.closedEvent())
    void this.read()
  }

  override addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: MessageEvent) => void) | null,
  ): void {
    super.addEventListener(type, listener as EventListener)
  }

  override removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: MessageEvent) => void) | null,
  ): void {
    super.removeEventListener(type, listener as EventListener)
  }

  get bufferedAmount() {
    return this.channel.bufferedAmount
  }

  waitBufferedBelow(threshold: number) {
    return this.channel.waitBufferedBelow(threshold)
  }

  send(data: string | Uint8Array) {
    void this.channel.send(data).catch(() => {
      this.dispatchEvent(new Event('error'))
      this.onerror?.()
      this.close()
    })
  }

  private async read() {
    try {
      while (!this.closed) {
        const value = await this.channel.receive()
        const data = typeof value === 'string' ? value : new Uint8Array(value).buffer
        const event = new MessageEvent('message', { data })
        this.dispatchEvent(event)
        this.onmessage?.(event)
      }
    } catch {
      this.closedEvent()
    }
  }

  private closedEvent() {
    if (this.closed) return
    this.closed = true
    this.dispatchEvent(new Event('close'))
    this.onclose?.()
  }

  close() {
    this.closedEvent()
    void this.channel.close().catch(() => {})
  }
}

export class WebRTCSession {
  constructor(
    readonly connection: WebRTCConnection,
    private readonly session: CoreSession,
  ) {
    markRaw(this)
  }

  isConnected() {
    return this.session.isConnected()
  }

  async openDataChannel(label: string) {
    return new DirectChannel(await this.connection.openChannel(label))
  }
}

export async function connectWAMP(config: ClientConfig): Promise<[Session, WebRTCSession]> {
  const peer = await WebRTCConnection.connect(config.session.native, config.realm, config)
  return [
    new OwnedSession(peer, undefined, () => peer.connection.close()),
    new WebRTCSession(peer.connection, peer),
  ]
}
