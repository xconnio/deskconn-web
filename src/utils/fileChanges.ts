/**
 * In-page notice that a file on a machine was created, edited, renamed or
 * deleted from this website, so other open views (e.g. the text editor's file
 * tree) can refresh without polling the device.
 */
type FileChangeListener = (realm: string, path: string) => void

const listeners = new Set<FileChangeListener>()

export function notifyFileChanged(realm: string, ...paths: string[]) {
  for (const listener of listeners) {
    for (const path of paths) listener(realm, path)
  }
}

/** Returns the unsubscribe function. */
export function onFileChanged(listener: FileChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
