/**
 * Shared client for `io.xconn.deskconn.file.browse` — extracted from
 * EmbeddedDesktopFiles.vue so other browse UIs (the text editor's file tree and
 * open/save picker) can reuse the same parsing and pre-pagination protocol
 * fallback without duplicating it.
 */
import type { Session } from '@/services/xconn'
import { encryptPayload, decryptPayload, type EncryptionKeys } from '@/utils/encryption'
import type { FileBrowseResult, FileEntry } from '@/types'

const procedureFileBrowse = 'io.xconn.deskconn.file.browse'
const DEFAULT_PAGE_SIZE = 100

function getValue(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    if (key in source) {
      return source[key]
    }
  }

  return undefined
}

function getStringValue(source: Record<string, unknown>, ...keys: string[]) {
  const value = getValue(source, ...keys)
  return typeof value === 'string' ? value : ''
}

function getDateValue(source: Record<string, unknown>, ...keys: string[]) {
  const value = getValue(source, ...keys)
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function getBooleanValue(source: Record<string, unknown>, ...keys: string[]) {
  const value = getValue(source, ...keys)
  return typeof value === 'boolean' ? value : false
}

function getNumberValue(source: Record<string, unknown>, ...keys: string[]) {
  const value = getValue(source, ...keys)
  return typeof value === 'number' ? value : 0
}

export function parseFileEntry(raw: unknown): FileEntry {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  return {
    name: getStringValue(source, 'name', 'Name'),
    path: getStringValue(source, 'path', 'Path'),
    type: getStringValue(source, 'type', 'Type'),
    mode: getStringValue(source, 'mode', 'Mode'),
    size: getNumberValue(source, 'size', 'Size'),
    hidden: getBooleanValue(source, 'hidden', 'Hidden'),
    mod_time: getStringValue(source, 'mod_time', 'ModTime'),
    is_dir: getBooleanValue(source, 'is_dir', 'IsDir'),
    is_symlink: getBooleanValue(source, 'is_symlink', 'IsSymlink'),
    link_target: getStringValue(source, 'link_target', 'LinkTarget'),
    item_count: getValue(source, 'item_count', 'ItemCount') as number | undefined,
    thumbnail: getStringValue(source, 'thumbnail', 'Thumbnail') || undefined,
  }
}

export function parseBrowseResult(raw: unknown): FileBrowseResult {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const rawEntries = getValue(source, 'entries', 'Entries')
  const entries = Array.isArray(rawEntries) ? rawEntries.map(parseFileEntry) : []

  return {
    path: getStringValue(source, 'path', 'Path'),
    home_path: getStringValue(source, 'home_path', 'HomePath'),
    parent_path: getStringValue(source, 'parent_path', 'ParentPath'),
    type: getStringValue(source, 'type', 'Type'),
    mode: getStringValue(source, 'mode', 'Mode'),
    size: getNumberValue(source, 'size', 'Size'),
    mod_time: getDateValue(source, 'mod_time'),
    is_dir: getBooleanValue(source, 'is_dir', 'IsDir'),
    is_symlink: getBooleanValue(source, 'is_symlink', 'IsSymlink'),
    link_target: getStringValue(source, 'link_target', 'LinkTarget'),
    entries,
    next_cursor: getStringValue(source, 'next_cursor', 'NextCursor') || undefined,
    has_more: getBooleanValue(source, 'has_more', 'HasMore'),
  }
}

/**
 * One browser per connection: pre-pagination deskconnd only understood a raw path
 * string as the file.browse payload, so the first call also doubles as a protocol
 * probe, and which protocol worked has to stick for the rest of the connection
 * (hence per-instance state rather than a stateless function — two independent
 * browse UIs, e.g. Files and the text editor's picker, run this concurrently and
 * must not share one global fallback flag).
 */
export function createFileBrowser(session: Session, getKeys: () => EncryptionKeys | null) {
  let legacyBrowseProtocol = false
  let hasProbedBrowseProtocol = false

  async function callFileBrowse(payloadText: string): Promise<FileBrowseResult> {
    const keys = getKeys()
    let browse: FileBrowseResult | undefined

    if (keys) {
      const payloadBytes = new TextEncoder().encode(payloadText)
      const encryptedPayload = encryptPayload(payloadBytes, keys.encryptKey)
      const result = await session.call(procedureFileBrowse, [encryptedPayload])

      const encryptedBytes = result.args?.[0] as Uint8Array
      if (!encryptedBytes?.length) throw new Error('Empty response from remote file browser')

      const decrypted = decryptPayload(encryptedBytes, keys.decryptKey)
      browse = parseBrowseResult(JSON.parse(new TextDecoder().decode(decrypted)))
    } else {
      const result = await session.call(procedureFileBrowse, [payloadText])
      browse = result.args?.[0] ? parseBrowseResult(result.args[0]) : undefined
    }

    if (!browse || !browse.path) {
      throw new Error('Empty response from remote file browser')
    }
    return browse
  }

  async function browseFiles(path: string, cursor?: string, limit = DEFAULT_PAGE_SIZE): Promise<FileBrowseResult> {
    if (legacyBrowseProtocol) return callFileBrowse(path)

    const payload = JSON.stringify({ path, cursor, limit })
    try {
      const browse = await callFileBrowse(payload)
      hasProbedBrowseProtocol = true
      return browse
    } catch (err) {
      // Only the first browse of a connection doubles as a protocol probe — an
      // old deskconnd chokes on the JSON payload (it tries to Lstat the literal
      // JSON text as a path). Once we know which protocol works, later errors
      // (bad path, permissions, etc.) are real and must surface normally rather
      // than triggering another silent retry.
      if (hasProbedBrowseProtocol) throw err
      hasProbedBrowseProtocol = true

      try {
        const browse = await callFileBrowse(path)
        legacyBrowseProtocol = true
        return browse
      } catch {
        // Both attempts failed — the JSON-payload error is more likely the
        // genuine one (a real backend understood it and hit a real problem), so
        // surface that instead of the raw-path retry's parse error.
        throw err
      }
    }
  }

  return { browseFiles }
}
