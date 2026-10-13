import { ref } from 'vue'
import { defineStore } from 'pinia'

import { authService } from '../services/authService'
import type { WampSession } from '../services/wamp'
import type { Desktop } from '../types'

export const useMachinesStore = defineStore('machines', () => {
  const desktops = ref<Desktop[]>([])
  const isLoadingDesktops = ref(false)
  const hasLoadedDesktops = ref(false)

  async function fetchMachines(session: WampSession, force = false) {
    if (isLoadingDesktops.value || (hasLoadedDesktops.value && !force)) {
      return
    }

    isLoadingDesktops.value = true

    try {
      const result = await authService.listDesktops(session)
      desktops.value = result.args.map((desktop: Desktop) => ({
        ...desktop,
        icon: '🖥️',
      }))
      hasLoadedDesktops.value = true
    } catch (err) {
      console.error('Failed to fetch desktops', err)
    } finally {
      isLoadingDesktops.value = false
    }
  }

  // Standalone mode has no machine list to fetch, just the one machine logged in to.
  function setStandaloneMachine(name: string, realm: string) {
    desktops.value = [{ id: 'standalone', name, realm, icon: '🖥️', role: 'owner' }]
    isLoadingDesktops.value = false
    hasLoadedDesktops.value = true
  }

  function clearMachines() {
    desktops.value = []
    isLoadingDesktops.value = false
    hasLoadedDesktops.value = false
  }

  return {
    desktops,
    isLoadingDesktops,
    hasLoadedDesktops,
    fetchMachines,
    setStandaloneMachine,
    clearMachines,
  }
})
