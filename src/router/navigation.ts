import { ref } from 'vue'
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

// Set just before a dock-wheel/swipe machine switch so App.vue slides the
// desktops (1: new one enters from the right, -1: from the left).
export const machineSlideDir = ref(0)
export const MACHINE_SLIDE_MS = 250
let slideEnd = 0

export function slideToMachine(realm: string, dir: number) {
  // One switch per slide, like GNOME: wheel/trackpad events landing mid-slide
  // are dropped instead of restarting the animation halfway.
  if (performance.now() < slideEnd) return
  slideEnd = performance.now() + MACHINE_SLIDE_MS
  machineSlideDir.value = dir
  openLauncher(realm)
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
