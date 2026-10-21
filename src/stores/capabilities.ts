import { ref } from 'vue'
import { defineStore } from 'pinia'

import { useSessionCacheStore } from '@/stores/sessionCache'
import { formatDesktopError } from '@/utils/desktopError'

const PROCEDURE_LIST = 'io.xconn.deskconn.capabilities.list'
const PROCEDURE_SET = 'io.xconn.deskconn.admin.capabilities.set'

/** One app the machine's owner/admin can turn on or off (deskconnd's capabilities.list). */
export interface Capability {
  id: string
  name: string
  enabled: boolean
  /** Apps this one can't work without: turning one off turns this off too. */
  requires: string[]
  /** The procedure to exchange keys with before calling the app's procedures. */
  key_exchange?: string
}

export const useCapabilitiesStore = defineStore('capabilities', () => {
  const sessionCacheStore = useSessionCacheStore()

  /** Per realm; missing until fetched, or for a deskconnd too old to have capabilities. */
  const byRealm = ref<Record<string, Capability[]>>({})

  async function fetch(realm: string) {
    const session = await sessionCacheStore.acquire(realm)
    if (!session) return
    try {
      const result = await session.call(PROCEDURE_LIST)
      byRealm.value[realm] = (result.args?.[0] as Capability[]) ?? []
    } catch {
      // Older deskconnd without capabilities: every app stays available.
      delete byRealm.value[realm]
    }
  }

  /** Enables or disables an app; throws a readable message (e.g. not an owner/admin). */
  async function set(realm: string, id: string, enabled: boolean) {
    const session = await sessionCacheStore.acquire(realm)
    if (!session) throw new Error('Desktop is offline.')
    try {
      const result = await session.call(PROCEDURE_SET, [id, enabled])
      byRealm.value[realm] = (result.args?.[0] as Capability[]) ?? []
    } catch (err) {
      throw new Error(formatDesktopError(err))
    }
  }

  /** False only for an app the machine reports as disabled; unknown apps (Settings,
   * viewers) and older machines count as enabled. */
  function isEnabled(realm: string, id: string): boolean {
    return byRealm.value[realm]?.find((c) => c.id === id)?.enabled ?? true
  }

  /** For apps served outside deskconnd (media-app's Pictures, Videos, Documents): only
   * shown while the machine lists them as enabled, i.e. while their process runs. Older
   * machines, without capabilities, serve them themselves. */
  function isListed(realm: string, id: string): boolean {
    const list = byRealm.value[realm]
    return !list || (list.find((c) => c.id === id)?.enabled ?? false)
  }

  /** The app's key exchange; undefined on older machines, which serve every app with
   * deskconnd's own. */
  function keyExchange(realm: string, id: string): string | undefined {
    return byRealm.value[realm]?.find((c) => c.id === id)?.key_exchange
  }

  return { byRealm, fetch, set, isEnabled, isListed, keyExchange }
})
