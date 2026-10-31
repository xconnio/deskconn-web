import type { Session } from '@/services/xconn'
import { useSessionEncryptionStore } from '@/stores/sessionEncryption'
import { encryptPayload, decryptPayload } from '@/utils/encryption'
import { isKeysRejectedError } from '@/utils/desktopError'

// Calls one of deskconnd's end-to-end encrypted procedures, or another app's
// with that app's keyExchange (see capabilities.ts). Its argument, if any, and
// its result are each a single JSON value encrypted with the key-exchange keys.
export async function encryptedCall<T>(
  session: Session,
  realm: string,
  procedure: string,
  arg?: unknown,
  keyExchange?: string,
): Promise<T> {
  const encryptionStore = useSessionEncryptionStore()

  for (let attempt = 0; ; attempt++) {
    const keys = await encryptionStore.getOrExchange(session, realm, keyExchange)
    const args = arg === undefined
      ? []
      : [encryptPayload(new TextEncoder().encode(JSON.stringify(arg)), keys.encryptKey)]
    try {
      const result = await session.call(procedure, args)
      const encrypted = result.args?.[0] as Uint8Array
      if (!encrypted?.length) throw new Error(`Empty response from ${procedure}`)
      return JSON.parse(new TextDecoder().decode(decryptPayload(encrypted, keys.decryptKey))) as T
    } catch (e) {
      // The desktop no longer has these keys: exchange again and retry once. It
      // rejected the call before running it, so nothing is repeated.
      if (attempt === 0 && isKeysRejectedError(e)) {
        encryptionStore.invalidate(realm)
        continue
      }
      throw e
    }
  }
}
