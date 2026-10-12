/**
 * Client side of `io.xconn.deskconn.deskconnd.file.cat` (see filecat.go) — simpler
 * than file.download: raw encrypted chunks stream straight through, no framing.
 * The path goes as an encrypted JSON string and each chunk comes back encrypted,
 * both with the realm's key-exchange keys.
 */
import { type Session } from 'xconn'
import { useSessionEncryptionStore } from '@/stores/sessionEncryption'
import { encryptPayload, decryptPayload } from '@/utils/encryption'
import { isKeysRejectedError } from '@/utils/desktopError'

const procedureFileCat = 'io.xconn.deskconn.deskconnd.file.cat'

type CallResult = { args?: unknown[] }

export async function streamFileCat(
  session: Session,
  realm: string,
  remotePath: string,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const encryptionStore = useSessionEncryptionStore()
  try {
    return await streamFileCatOnce(session, realm, remotePath, onChunk, signal)
  } catch (e) {
    // The desktop no longer has these keys: it rejected the call before sending
    // anything, so exchange again and retry once.
    if (!isKeysRejectedError(e)) throw e
    encryptionStore.invalidate(realm)
    return await streamFileCatOnce(session, realm, remotePath, onChunk, signal)
  }
}

async function streamFileCatOnce(
  session: Session,
  realm: string,
  remotePath: string,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('cancelled')

  const keys = await useSessionEncryptionStore().getOrExchange(session, realm)
  const encryptedPath = encryptPayload(new TextEncoder().encode(JSON.stringify(remotePath)), keys.encryptKey)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const progressResult: any = await session.callProgress(procedureFileCat, [encryptedPath])

  const queue: CallResult[] = []
  let wakeUp: (() => void) | null = null
  let streamDone = false
  let streamError: unknown = null

  const notify = () => { const fn = wakeUp; wakeUp = null; fn?.() }
  progressResult.registerProgress((result: CallResult) => { queue.push(result); notify() })
  progressResult.finalResultPromise
    .then(() => { streamDone = true; notify() })
    .catch((err: unknown) => { streamError = err; streamDone = true; notify() })

  const onAbort = () => notify()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      if (signal?.aborted) throw new Error('cancelled')
      if (queue.length === 0) {
        if (streamDone) break
        await new Promise<void>((resolve) => { wakeUp = resolve })
        continue
      }
      const result = queue.shift()!
      const args = (result.args ?? []) as unknown[]
      const encrypted = args[0] as Uint8Array | undefined
      if (!encrypted) continue
      const chunk = decryptPayload(encrypted, keys.decryptKey)
      await onChunk(chunk)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  if (streamError) throw streamError instanceof Error ? streamError : new Error('Stream failed')
}
