/**
 * Client side of uploading a file over deskconn's stream-based file-transfer
 * protocol (see services/fileStream.ts). Each upload opens its own stream and
 * does its own key exchange, so — unlike the old shared-session-key RPC this
 * replaces — nothing here is shared across windows/callers.
 */
import { type Session } from 'xconn'
import { uploadFile, type UploadProgress } from '@/services/fileStream'
import { notifyFileChanged } from '@/utils/fileChanges'
import { joinPath } from '@/utils/filePath'

export type { UploadProgress }

export async function uploadFileToPath(
  session: Session,
  realm: string,
  destDir: string,
  fileName: string,
  file: Blob,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await uploadFile(session, realm, destDir, fileName, file, onProgress, signal)
  notifyFileChanged(realm, joinPath(destDir, fileName))
}
