import { defineStore } from 'pinia'
import type { Session } from 'xconn'
import { createX25519KeyPair, deriveSessionKeys, type EncryptionKeys } from '@/utils/encryption'

const procedureKeyExchange = 'io.xconn.deskconn.key.exchange'

// One key per realm session and key exchange (backend enforces this too, see
// d.keys) — shared so no window redoes the handshake behind another's back and
// invalidates it. Keyed by realm for deskconnd's key exchange, and by realm and
// procedure for other apps' (see capabilities.ts).
const cache = new Map<string, EncryptionKeys>()
const pending = new Map<string, Promise<EncryptionKeys>>()
// Re-exchange on reconnect, since the backend drops its half on session leave.
const hookedSessions = new WeakSet<Session>()

function cacheKey(realm: string, procedure: string): string {
  return procedure === procedureKeyExchange ? realm : `${realm} ${procedure}`
}

// Drops the realm's keys of apps other than deskconnd.
function dropAppKeys(realm: string) {
  for (const key of [...cache.keys()]) if (key.startsWith(`${realm} `)) cache.delete(key)
}

async function exchange(session: Session, procedure = procedureKeyExchange): Promise<EncryptionKeys> {
  const { publicKey, privateKey } = createX25519KeyPair()
  const result = await session.call(procedure, [publicKey])
  const serverPublicKey = result.args?.[0] as Uint8Array
  if (!serverPublicKey?.length) throw new Error('Invalid key exchange response')
  return deriveSessionKeys(privateKey, serverPublicKey)
}

export const useSessionEncryptionStore = defineStore('sessionEncryption', () => {
  async function getOrExchange(
    session: Session,
    realm: string,
    procedure = procedureKeyExchange,
  ): Promise<EncryptionKeys> {
    if (!hookedSessions.has(session)) {
      hookedSessions.add(session)
      session.onDisconnect(async () => { invalidate(realm); pending.delete(realm) })
    }

    const key = cacheKey(realm, procedure)
    const existing = cache.get(key)
    if (existing) return existing

    const inFlight = pending.get(key)
    if (inFlight) return inFlight

    const attempt = exchange(session, procedure).then((keys) => {
      cache.set(key, keys)
      return keys
    })

    pending.set(key, attempt)
    try {
      return await attempt
    } finally {
      if (pending.get(key) === attempt) pending.delete(key)
    }
  }

  function invalidate(realm: string) {
    cache.delete(realm)
    dropAppKeys(realm)
  }

  // deskconnd keys by caller session, so a direct upgrade needs its own
  // exchange. Written into the existing object in place so components that
  // already hold it pick up the new keys without re-fetching.
  function adopt(realm: string, keys: EncryptionKeys) {
    const existing = cache.get(realm)
    if (existing) Object.assign(existing, keys)
    else cache.set(realm, keys)
    // Other apps' keys were for the old session; they're exchanged again on next use.
    dropAppKeys(realm)
  }

  function isExchanging(realm: string): boolean {
    return pending.has(realm)
  }

  return { getOrExchange, invalidate, exchange, adopt, isExchanging }
})
