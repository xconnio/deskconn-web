import { ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { Session } from 'xconn'
import type { WebRTCSession } from 'xconn-webrtc-js'
import { registerWebRTCSession } from '../services/rtcRegistry'
import { useAuthStore } from './auth'
import { useSessionEncryptionStore } from './sessionEncryption'

const DIRECT_TIMEOUT_MS = 10_000

// Realm -> the session currently upgraded to direct. Keyed to the session (not
// just the realm) so an old session dropping can't clear a newer one's flag.
const directSessions = shallowRef(new Map<string, Session>())

function setDirect(realm: string, session: Session, on: boolean) {
  const has = directSessions.value.get(realm) === session
  if (on === has) return
  const next = new Map(directSessions.value)
  if (on) next.set(realm, session)
  else next.delete(realm)
  directSessions.value = next
}

// Both live outside the store so they persist across hot reloads / resets
const cache = new Map<string, Session>()
// De-dupes concurrent acquire() calls for the same realm so two callers never
// race separate authStore.shell() attempts against each other.
const pending = new Map<string, Promise<Session | null>>()

export const useSessionCacheStore = defineStore('sessionCache', () => {
  // Individual panels (terminal, files, ...) notice a dead desktop as soon as
  // their next call fails — well before the session's own transport-level
  // onDisconnect fires, which for plain WAMP can lag far behind since the
  // browser's socket to the router stays open. Reactive so DesktopSessionHost
  // can blur immediately instead of waiting on the slower session-level signal.
  const unreachableRealms = ref(new Set<string>())

  function reportUnreachable(realm: string) {
    if (!unreachableRealms.value.has(realm)) {
      unreachableRealms.value = new Set(unreachableRealms.value).add(realm)
    }
    invalidate(realm)
  }

  function clearUnreachable(realm: string) {
    if (unreachableRealms.value.has(realm)) {
      const next = new Set(unreachableRealms.value)
      next.delete(realm)
      unreachableRealms.value = next
    }
  }

  async function acquire(realm: string): Promise<Session | null> {
    const existing = cache.get(realm)
    if (existing?.isConnected()) return existing
    cache.delete(realm)

    const inFlight = pending.get(realm)
    if (inFlight) return inFlight

    const attempt = (async (): Promise<Session | null> => {
      const authStore = useAuthStore()
      const routed = await authStore.shellWamp(realm)
      if (!routed) return null

      const session = upgradable(realm, routed as Session)
      cache.set(realm, session)

      session.onDisconnect(async () => {
        if (cache.get(realm) === session) cache.delete(realm)
      })

      return session
    })()

    pending.set(realm, attempt)
    try {
      return await attempt
    } finally {
      if (pending.get(realm) === attempt) pending.delete(realm)
    }
  }

  function invalidateAll() {
    for (const [realm, session] of [...cache]) {
      cache.delete(realm)
      session.leave().catch(() => {})
    }
  }

  // Discards a realm's cached session even if it's still "connected" at the
  // router level (e.g. deskconnd itself is unreachable) so the next acquire()
  // reconnects from scratch instead of reusing a stale fallback session.
  function invalidate(realm: string) {
    const session = cache.get(realm)
    if (!session) return
    cache.delete(realm)
    session.leave().catch(() => {})
  }

  function isActive(realm: string): boolean {
    return cache.get(realm)?.isConnected() ?? false
  }

  function isAnyActive(): boolean {
    for (const session of cache.values()) {
      if (session.isConnected()) return true
    }
    return false
  }

  // Reactive: flips once the background direct upgrade lands (see upgradable()).
  function isDirect(realm: string): boolean {
    return directSessions.value.has(realm)
  }

  return {
    acquire,
    isDirect,
    invalidateAll,
    invalidate,
    isActive,
    isAnyActive,
    unreachableRealms,
    reportUnreachable,
    clearUnreachable,
  }
})

// Routed first so the desktop is usable right away; direct is negotiated over
// that same session in the background and swapped in once it's up. Callers
// keep this one stable object, so the upgrade is invisible to them. The
// routed session stays open after the swap: it carries the WebRTC signaling
// and any WebTransport streams opened before the upgrade.
// ponytail: no fallback to routed if direct later drops — the whole session
// disconnects and the next acquire() starts over (routed, then direct again).
function upgradable(realm: string, routed: Session): Session {
  let current = routed
  let direct: Session | null = null
  let closed = false
  let inflight = 0
  const callbacks: Array<(reason: string) => Promise<void>> = []

  async function drop(reason: string) {
    if (closed) return
    closed = true
    setDirect(realm, session, false)
    for (const s of [routed, direct]) if (s?.isConnected()) s.leave().catch(() => {})
    for (const cb of callbacks) await cb(reason).catch(() => {})
  }

  function track<T>(p: Promise<T>): Promise<T> {
    inflight++
    return p.finally(() => inflight--)
  }

  const overrides: Record<string | symbol, unknown> = {
    call: (...args: Parameters<Session['call']>) => track(current.call(...args)),
    callProgress: async (...args: Parameters<Session['callProgress']>) => {
      inflight++
      try {
        const result = await current.callProgress(...args)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(result as any).finalResultPromise.catch(() => {}).finally(() => inflight--)
        return result
      } catch (err) {
        inflight--
        throw err
      }
    },
    isConnected: () => !closed && current.isConnected(),
    onDisconnect: (cb: (reason: string) => Promise<void>) => { callbacks.push(cb) },
    leave: () => drop('wamp.close.close_realm'),
  }

  const session = new Proxy(routed, {
    get(_, prop) {
      if (prop in overrides) return overrides[prop]
      // openStream/openSession are WebTransport-only features, so they always stay routed.
      const target = prop === 'openStream' || prop === 'openSession' ? routed : current
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  routed.onDisconnect(async (reason) => {
    if (current === routed) await drop(reason)
  })

  void (async () => {
    const authStore = useAuthStore()
    const encryption = useSessionEncryptionStore()
    const attempt = authStore.shellWebRTC(realm, routed)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('WebRTC connection timeout')), DIRECT_TIMEOUT_MS)
    })
    let webrtc: WebRTCSession
    try {
      const result = await Promise.race([attempt, timeout])
      if (!result) return
      ;[direct, webrtc] = result as [Session, WebRTCSession]
    } catch {
      // Timed out or failed: stay routed, and close a late direct session if it shows up.
      attempt.then((r) => { if (r) r[0].leave().catch(() => {}) }).catch(() => {})
      return
    } finally {
      clearTimeout(timer)
    }

    const upgraded = direct
    try {
      // Fails on deskconnd builds without key exchange — nothing to re-key then.
      const keys = await encryption.exchange(upgraded).catch(() => null)
      // Swap only while nothing is in flight on routed: an encrypted call or
      // key exchange straddling the swap would decrypt with the wrong keys.
      while (!closed && (inflight > 0 || encryption.isExchanging(realm))) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (closed || !upgraded.isConnected()) throw new Error('session closed during upgrade')

      if (keys) encryption.adopt(realm, keys)
      else encryption.invalidate(realm)
      registerWebRTCSession(session, webrtc)
      current = upgraded
      upgraded.onDisconnect(drop)
      setDirect(realm, session, true)
    } catch {
      direct = null
      upgraded.leave().catch(() => {})
    }
  })()

  return session
}
