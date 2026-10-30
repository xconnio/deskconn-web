import { ref } from 'vue'
import { defineStore } from 'pinia'

import { useSessionCacheStore } from '@/stores/sessionCache'

export type DockPosition = 'bottom' | 'left' | 'right'

const VALID_DOCK_POSITIONS: DockPosition[] = ['bottom', 'left', 'right']

const PROCEDURE_MACHINE_SETTINGS_LIST = 'io.xconn.deskconn.settings.list'
const PROCEDURE_MACHINE_SETTINGS_SAVE = 'io.xconn.deskconn.settings.save'

function readDockPosition(realm: string): DockPosition {
  const stored = localStorage.getItem(`setting_dock_position_${realm}`)
  return VALID_DOCK_POSITIONS.includes(stored as DockPosition) ? (stored as DockPosition) : 'left'
}

function readResourceMonitorInterval(realm: string): number {
  return parseInt(localStorage.getItem(`setting_resource_monitor_interval_${realm}`) ?? '1', 10)
}

export const useSettingsStore = defineStore('settings', () => {
  const sessionCacheStore = useSessionCacheStore()
  const lastRealm = ref(localStorage.getItem('setting_last_realm'))
  // Defaults to on for touch-only devices: iPad Safari has no reliable double-tap.
  const singleClickOpen = ref(
    (localStorage.getItem('setting_single_click_open') ?? String(window.matchMedia('(hover: none)').matches)) === 'true',
  )
  const useRemoteWallpaper = ref(localStorage.getItem('setting_use_remote_wallpaper') !== 'false')
  const showLogicalCpus = ref(localStorage.getItem('setting_show_logical_cpus') === 'true')
  // Dock position and resource monitor refresh interval are per-machine —
  // set via the "Settings" app inside each machine's dock, not a global
  // account preference — so they're keyed by realm and hydrated lazily
  // rather than loaded all at once.
  const dockPositions = ref<Record<string, DockPosition>>({})
  const resourceMonitorIntervals = ref<Record<string, number>>({})

  // The user's settings kept on the machine itself (deskconnd's settings.list/save), so
  // they follow them to any browser: string values by key, per realm. Missing until
  // fetched, or on a deskconnd too old to keep them — localStorage stays the fallback.
  const machineSettings = ref<Record<string, Record<string, string>>>({})

  async function fetchMachineSettings(realm: string) {
    const session = await sessionCacheStore.acquire(realm)
    if (!session) return
    try {
      const result = await session.call(PROCEDURE_MACHINE_SETTINGS_LIST)
      const values = (result.args?.[0] as Record<string, string>) ?? {}
      machineSettings.value[realm] = values
      // Mirrored into localStorage too, so the next load starts out right.
      if (VALID_DOCK_POSITIONS.includes(values.dock_position as DockPosition)) {
        dockPositions.value[realm] = values.dock_position as DockPosition
        localStorage.setItem(`setting_dock_position_${realm}`, values.dock_position!)
      }
      const interval = parseInt(values.resource_monitor_interval ?? '', 10)
      if (interval > 0) {
        resourceMonitorIntervals.value[realm] = interval
        localStorage.setItem(`setting_resource_monitor_interval_${realm}`, String(interval))
      }
    } catch {
      // Older deskconnd without settings: keep this browser's.
    }
  }

  function getMachineSetting(realm: string, key: string): string | undefined {
    return machineSettings.value[realm]?.[key]
  }

  // Only sent when it differs from what the machine has, and over an already-live
  // session — never worth (re)connecting a machine for. The cache only takes values
  // the machine took, so one that failed to send is sent again next time.
  function setMachineSetting(realm: string, key: string, value: string) {
    if (machineSettings.value[realm]?.[key] === value) return
    if (!sessionCacheStore.isActive(realm)) return
    const settings = (machineSettings.value[realm] ??= {})
    const previous = settings[key]
    settings[key] = value
    sessionCacheStore.acquire(realm)
      .then((session) => session?.call(PROCEDURE_MACHINE_SETTINGS_SAVE, [key, value]))
      .catch(() => {
        if (settings[key] !== value) return
        if (previous === undefined) delete settings[key]
        else settings[key] = previous
      })
  }

  function getDockPosition(realm: string): DockPosition {
    if (!(realm in dockPositions.value)) {
      dockPositions.value[realm] = readDockPosition(realm)
    }
    return dockPositions.value[realm]!
  }

  function setDockPosition(realm: string, value: DockPosition) {
    dockPositions.value[realm] = value
    localStorage.setItem(`setting_dock_position_${realm}`, value)
    setMachineSetting(realm, 'dock_position', value)
  }

  function getResourceMonitorInterval(realm: string): number {
    if (!(realm in resourceMonitorIntervals.value)) {
      resourceMonitorIntervals.value[realm] = readResourceMonitorInterval(realm)
    }
    return resourceMonitorIntervals.value[realm]!
  }

  function setResourceMonitorInterval(realm: string, value: number) {
    resourceMonitorIntervals.value[realm] = value
    localStorage.setItem(`setting_resource_monitor_interval_${realm}`, String(value))
    setMachineSetting(realm, 'resource_monitor_interval', String(value))
  }

  function setSingleClickOpen(value: boolean) {
    singleClickOpen.value = value
    localStorage.setItem('setting_single_click_open', String(value))
  }

  function setUseRemoteWallpaper(value: boolean) {
    useRemoteWallpaper.value = value
    localStorage.setItem('setting_use_remote_wallpaper', String(value))
  }

  function setShowLogicalCpus(value: boolean) {
    showLogicalCpus.value = value
    localStorage.setItem('setting_show_logical_cpus', String(value))
  }

  function setLastRealm(realm: string) {
    lastRealm.value = realm
    localStorage.setItem('setting_last_realm', realm)
  }

  // Clears which machine to land on next — used when the user explicitly
  // navigates to the Machines picker, so reopening the app later (even in a
  // fresh browser session) lands back on the picker instead of jumping
  // straight into whatever machine was open before.
  function clearLastRealm() {
    lastRealm.value = null
    localStorage.removeItem('setting_last_realm')
  }

  return {
    lastRealm, setLastRealm, clearLastRealm,
    singleClickOpen, setSingleClickOpen,
    useRemoteWallpaper, setUseRemoteWallpaper,
    showLogicalCpus, setShowLogicalCpus,
    getDockPosition, setDockPosition,
    getResourceMonitorInterval, setResourceMonitorInterval,
    fetchMachineSettings, getMachineSetting, setMachineSetting,
  }
})
