const DB_NAME = 'deskconn-wallpaper'
const STORE = 'wallpapers'

interface WallpaperRecord {
  blob: Blob
  checksum: string
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function loadCachedWallpaper(realm: string): Promise<{ url: string; checksum: string } | null> {
  try {
    const db = await openDB()
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(realm)
      req.onsuccess = () => {
        const record = req.result as WallpaperRecord | undefined
        if (!record) { resolve(null); return }
        resolve({ url: URL.createObjectURL(record.blob), checksum: record.checksum })
      }
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function storeWallpaper(realm: string, data: Uint8Array, mimeType: string, checksum: string): Promise<string> {
  const blob = new Blob(
    [data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer],
    { type: mimeType },
  )
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put({ blob, checksum }, realm)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // storage failure is non-fatal; we still return a usable URL
  }
  return URL.createObjectURL(blob)
}

export async function deleteWallpaper(realm: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(realm)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // storage failure is non-fatal
  }
}
