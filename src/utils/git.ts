/**
 * Client side of `io.xconn.deskconn.git.status` / `.git.original` (see
 * filegit.go). Same encrypt/call/decrypt shape as TextEditor.vue's saveFile and
 * EmbeddedDesktopFiles.vue's callFileOperation.
 */
import type { Session } from 'xconn'
import { encryptPayload, decryptPayload, type EncryptionKeys } from '@/utils/encryption'

const procedureGitStatus = 'io.xconn.deskconn.git.status'
const procedureGitOriginal = 'io.xconn.deskconn.git.original'

export type GitFileStatus = 'untracked' | 'added' | 'modified' | 'ignored'

/** Only these three are ever reported — anything else (clean, renamed, ...)
 * is simply absent from GitStatusResult.entries. */
export interface GitStatusEntry {
  path: string
  status: GitFileStatus
}

export interface GitStatusResult {
  is_repo: boolean
  repo_root?: string
  entries?: GitStatusEntry[]
}

export interface GitOriginalResult {
  is_repo: boolean
  is_new: boolean
  untracked: boolean
  ignored: boolean
  content: string
}

async function callGitProcedure<T>(session: Session, keys: EncryptionKeys, procedure: string, path: string): Promise<T> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify({ path }))
  const encrypted = encryptPayload(payloadBytes, keys.encryptKey)

  const result = await session.call(procedure, [encrypted])
  const encryptedResult = result.args?.[0] as Uint8Array
  if (!encryptedResult?.length) throw new Error('Empty response from remote git query')

  const decrypted = decryptPayload(encryptedResult, keys.decryptKey)
  return JSON.parse(new TextDecoder().decode(decrypted)) as T
}

export function fetchGitStatus(session: Session, keys: EncryptionKeys, path: string): Promise<GitStatusResult> {
  return callGitProcedure<GitStatusResult>(session, keys, procedureGitStatus, path)
}

export function fetchGitOriginal(session: Session, keys: EncryptionKeys, path: string): Promise<GitOriginalResult> {
  return callGitProcedure<GitOriginalResult>(session, keys, procedureGitOriginal, path)
}
