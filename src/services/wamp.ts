import {
  connectWebTransportCRA,
  connectWebTransportCryptosign,
  type WebTransportCertHash,
  type Session,
  WAMPCRAAuthenticator,
  CryptoSignAuthenticator,
} from '@/services/xconn'
import { connectWAMP, ClientConfig, type WebRTCSession } from '@/services/xconn'

import { WAMP_WT_URL, WAMP_WT_CERT_URL, WAMP_REALM } from '../config'

// ponytail: cert hash cache is time-based, not rotation-aware; if rotation cadence
// tightens below this TTL, switch to invalidating on WebTransport connect failure instead.
const CERT_HASH_CACHE_TTL_MS = 5 * 60 * 1000

let certHashesPromise: Promise<WebTransportCertHash[] | undefined> | null = null
let certHashesCachedAt = 0

async function fetchCertHashes(): Promise<WebTransportCertHash[] | undefined> {
  if (typeof WebTransport === 'undefined') {
    throw new Error('This browser does not support WebTransport, which is required to connect. Please use a recent version of Chrome, Edge, or Firefox.')
  }
  if (!WAMP_WT_CERT_URL) return undefined
  if (!certHashesPromise || Date.now() - certHashesCachedAt > CERT_HASH_CACHE_TTL_MS) {
    certHashesCachedAt = Date.now()
    certHashesPromise = loadCertHashes().catch((err: unknown) => {
      certHashesPromise = null
      throw err
    })
  }
  return certHashesPromise
}

// WAMP_WT_CERT_URL is fetched cross-origin from the app's own origin (e.g. dev server on
// a different port than the router), so it must respond with Access-Control-Allow-Origin
// for that origin or the browser rejects the request before any response is visible here.
async function loadCertHashes(): Promise<WebTransportCertHash[]> {
  let resp: Response
  try {
    resp = await fetch(WAMP_WT_CERT_URL, { cache: 'no-store' })
  } catch (err) {
    throw new Error(
      `failed to reach WebTransport cert hash endpoint ${WAMP_WT_CERT_URL} (network error or missing CORS headers for this origin): ${err}`,
    )
  }
  if (!resp.ok) {
    throw new Error(`failed to load WebTransport cert hash from ${WAMP_WT_CERT_URL}: ${resp.status} ${resp.statusText}`)
  }
  const payload: unknown = await resp.json()
  if (typeof payload !== 'object' || payload === null || !('hash' in payload) || typeof (payload as { hash?: unknown }).hash !== 'string') {
    throw new Error(`invalid WebTransport cert hash payload from ${WAMP_WT_CERT_URL}`)
  }
  const { hash } = payload as { hash: string }
  const base64 = hash.replace(/-/g, '+').replace(/_/g, '/')
  const hashBytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return [{ algorithm: 'sha-256', value: hashBytes }]
}

// Static credentials for a machine running `deskconnd --standalone`: a password (wampcra)
// or a hex ed25519 private key (cryptosign), whichever the machine was started with.
export interface StandaloneCreds {
  url: string // https://host:port[/path], WebTransport
  authId: string
  password?: string
  privateKey?: string
}

export function standaloneAuthenticator(creds: StandaloneCreds) {
  return creds.privateKey
    ? new CryptoSignAuthenticator(creds.authId, creds.privateKey, {})
    : new WAMPCRAAuthenticator(creds.authId, creds.password ?? '', {})
}

// Same defaults as deskconn's ParseStandaloneURL: https scheme, path /wamp.
export function normalizeStandaloneURL(raw: string): string {
  const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
  if (u.protocol !== 'https:') throw new Error('Standalone URL must be https://host:port (WebTransport)')
  if (u.pathname === '' || u.pathname === '/') u.pathname = '/wamp'
  return u.toString()
}

export type WampSession = Session

export const wampService = {
  async connectWithCRA(authId: string, secret: string): Promise<WampSession> {
    return connectWebTransportCRA(WAMP_WT_URL, WAMP_REALM, authId, secret, await fetchCertHashes())
  },

  async connectWithCryptosign(authId: string, privateKey: string, realm: string): Promise<WampSession> {
    return connectWebTransportCryptosign(WAMP_WT_URL, realm, authId, privateKey, await fetchCertHashes())
  },

  async connectStandalone(creds: StandaloneCreds, realm: string): Promise<WampSession> {
    if (typeof WebTransport === 'undefined') {
      throw new Error('This browser does not support WebTransport, which is required to connect.')
    }
    // No certificate pinning: browsers only pin certificates valid for at most 14 days, so the
    // machine needs one from a CA the browser trusts (deskconnd --tls-cert/--tls-key).
    return creds.privateKey
      ? connectWebTransportCryptosign(creds.url, realm, creds.authId, creds.privateKey)
      : connectWebTransportCRA(creds.url, realm, creds.authId, creds.password ?? '')
  },

  async shellWithWebRTC(config: ClientConfig): Promise<[Session, WebRTCSession]> {
    return connectWAMP(config)
  },
}
