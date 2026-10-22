import router from './index'
import { useSettingsStore } from '../stores/settings'

export function openFiles(realm: string, desktopName?: string, initialPath?: string) {
  router.push({
    name: 'desktop-files',
    params: { realm },
    query: {
      ...(desktopName  ? { name: desktopName }      : {}),
      ...(initialPath  ? { path: initialPath }       : {}),
    },
  })
}

export function openLauncher(realm: string, notSupported?: string) {
  useSettingsStore().setLastRealm(realm)
  router.push({
    name: 'desktop-launcher',
    params: { realm },
    query: notSupported ? { notSupported } : {},
  })
}

export function openIndexedFiles(realm: string, category: string, desktopName?: string) {
  router.push({
    name: 'desktop-index',
    params: { realm, category },
    query: desktopName ? { name: desktopName } : {},
  })
}

export function openWindowsOverview(realm: string) {
  router.push({ name: 'desktop-windows', params: { realm } })
}
