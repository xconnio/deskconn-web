// Tracks which WampSession instances are backed by a live WebRTC P2P
// RTCPeerConnection, as opposed to a cloud-relay-only connection. Kept as a
// side table (rather than a property on Session) so the WAMP transport stays
// transport-agnostic; only components that specifically need P2P (e.g. raw
// data channel file streaming) need to consult it.
import { toRaw } from 'vue'
import type { WebRTCSession } from 'xconn-webrtc-js'

import type { WampSession } from './wamp'

// Keyed by the raw session: a session that ends up in Vue state (e.g. a window's props)
// comes back as a reactive proxy, which a WeakMap wouldn't recognize. markRaw can't prevent
// that for sessionCache's upgradable proxy, which forwards reads to the P2P session after the
// upgrade, so its markRaw flag stops showing.
const registry = new WeakMap<object, WebRTCSession>()

export function registerWebRTCSession(session: WampSession, webrtc: WebRTCSession): void {
  registry.set(toRaw(session) as object, webrtc)
}

export function getWebRTCSession(session: WampSession | null | undefined): WebRTCSession | null {
  if (!session) return null
  const webrtc = registry.get(toRaw(session) as object)
  if (!webrtc || webrtc.connection.connectionState !== 'connected') return null
  return webrtc
}
