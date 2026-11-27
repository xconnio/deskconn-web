<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref, watch, nextTick, defineAsyncComponent } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'

import { machinesOverviewReturnRealm, rememberReturnPath } from './router/index'
import { machineSlideDir, MACHINE_SLIDE_MS } from './router/navigation'
import { STANDALONE_REALM } from './config'
import { useAuthStore } from './stores/auth'
import { useMachinesStore } from './stores/machines'
import { useDesktopSessionsStore } from './stores/desktopSessions'
import { useSessionCacheStore } from './stores/sessionCache'
import { useAccountPanelStore } from './stores/accountPanel'
import AccountPanel from './components/AccountPanel.vue'
import CommandPalette from './components/CommandPalette.vue'

const titleBar = window.deskconnTitleBar
const logoUrl = `${import.meta.env.BASE_URL}deskconn_logo.svg`

const DesktopSessionHost = defineAsyncComponent(() => import('./components/DesktopSessionHost.vue'))

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const machinesStore = useMachinesStore()
const desktopSessionsStore = useDesktopSessionsStore()
const sessionCacheStore = useSessionCacheStore()
const accountPanelStore = useAccountPanelStore()

const activeRealm = computed(() =>
  route.name === 'desktop-launcher' ? (route.params.realm as string) : null,
)

// The machine whose dock the overview pages show: Open Windows' own, or on
// Machines the one it was opened from — none on a fresh Machines landing.
const dockRealm = computed(() => {
  if (route.name === 'desktop-windows') return route.params.realm as string
  if (route.name === 'home') return machinesOverviewReturnRealm.value
  return null
})

// Machine sliding out during a dock-wheel/swipe switch, kept visible until
// its animation ends (see the activeRealm watcher below).
const leavingRealm = ref<string | null>(null)

const renderedRealms = computed(() => {
  const set = new Set(desktopSessionsStore.knownRealms)
  if (activeRealm.value) set.add(activeRealm.value)
  if (dockRealm.value) set.add(dockRealm.value)
  if (leavingRealm.value) set.add(leavingRealm.value)
  return [...set].filter(
    (r) =>
      r === activeRealm.value ||
      r === dockRealm.value ||
      r === leavingRealm.value ||
      desktopSessionsStore.hasOpenWindows(r),
  )
})

// Ubuntu-style workspace slide: old desktop moves out as the new one moves in.
watch(activeRealm, async (to, from) => {
  const dir = machineSlideDir.value
  machineSlideDir.value = 0
  if (!dir || !to || !from || to === from) return
  leavingRealm.value = from
  await nextTick()
  const host = (r: string) =>
    document.querySelector<HTMLElement>(`.main-content > [data-realm="${CSS.escape(r)}"]`)
  // Reduced motion: crossfade in place instead of moving.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches
  const shift = (x: number) => (still ? 'none' : `translateX(${x * 100}%)`)
  // GNOME's workspace switch: easeOutCubic over 250ms.
  const opts = { duration: MACHINE_SLIDE_MS, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' }
  // A first-visit host still runs its fade-in-up (translateY, 500ms); it would
  // outlast the slide and snap the desktop at the end, so end it now.
  host(to)?.getAnimations().forEach((anim) => anim instanceof CSSAnimation && anim.finish())
  host(to)?.animate(
    [{ transform: shift(dir), opacity: still ? 0 : 1 }, { transform: 'none', opacity: 1 }],
    opts,
  )
  await host(from)
    ?.animate(
      [{ transform: 'none', opacity: 1 }, { transform: shift(-dir), opacity: still ? 0 : 1 }],
      opts,
    )
    .finished.catch(() => {})
  if (leavingRealm.value === from) leavingRealm.value = null
})

function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (!desktopSessionsStore.anyOpenWindowsAnywhere() && !sessionCacheStore.isAnyActive()) return
  e.preventDefault()
}

const isDesktopView = computed(() => route.name === 'desktop-launcher')
const hasDarkBackground = computed(() => isDesktopView.value || route.name === 'home')

// Hidden wherever an OverviewGrid page (Machines, Open Windows) is already
// showing its own close/back button — the two would sit in the same corner.
// Machines only has one when reached from an open session; Open Windows
// always does.
const showAccountBtn = computed(
  () =>
    authStore.isAuthenticated &&
    !isDesktopView.value &&
    route.name !== 'desktop-windows' &&
    !(route.name === 'home' && machinesOverviewReturnRealm.value),
)

// Resets the tab title when leaving all desktop sessions (DesktopSessionHost sets it while active).
watch(activeRealm, (realm) => {
  if (!realm) document.title = 'Deskconn'
})

watch(
  () => [authStore.session, authStore.standalone] as const,
  ([session, standalone]) => {
    if (standalone) {
      machinesStore.setStandaloneMachine(new URL(standalone.url).host, STANDALONE_REALM)
      return
    }
    if (session) {
      machinesStore.fetchMachines(session)
      return
    }

    machinesStore.clearMachines()
    desktopSessionsStore.reset()
  },
  { immediate: true },
)

onMounted(async () => {
  window.addEventListener('beforeunload', handleBeforeUnload)

  try {
    const success = await authStore.autoLogin()
    if (success) {
      if (
        router.currentRoute.value.path === '/login' ||
        router.currentRoute.value.path === '/register'
      ) {
        router.push('/')
      }
    } else if (router.currentRoute.value.meta.requiresAuth) {
      // No stored principal, or it was expired/deleted (autoLogin already
      // cleared it) — a route that requires auth was only reachable because
      // `user` was optimistically loaded from stale localStorage at store
      // creation, before this real check ran.
      rememberReturnPath(router.currentRoute.value.fullPath)
      router.push('/login')
    }
  } catch (err) {
    console.error('Auto-login failed', err)
    authStore.logout()
    if (router.currentRoute.value.path !== '/login') {
      router.push('/login')
    }
  }
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<template>
  <div class="app-wrapper" :class="{ 'electron-window': titleBar, 'electron-mac': titleBar === 'mac' }">
    <header v-if="titleBar" class="electron-title-bar">
      <div class="electron-title-bar-content">
        <img :src="logoUrl" width="18" height="18" alt="" />
        <span>DeskConn</span>
      </div>
    </header>

    <!-- Main content -->
    <main class="main-content" :class="{ 'is-desktop': hasDarkBackground, 'is-sliding': leavingRealm }">
      <RouterView />
      <div id="overview-dock"></div>
      <DesktopSessionHost
        v-for="r in renderedRealms"
        :key="r"
        :data-realm="r"
        :class="{ 'slide-leaving': r === leavingRealm }"
        :realm="r"
        :active="r === activeRealm"
        :dock-elsewhere="r === dockRealm"
        v-show="r === activeRealm || r === leavingRealm"
      />
    </main>

    <!-- Same account entry point as the in-session dock (AppDock's Profile
         icon) — hidden there since AppDock already provides its own. -->
    <button
      v-if="showAccountBtn"
      class="global-account-btn"
      title="Profile"
      @click="accountPanelStore.open('account')"
    >
      <i class="bi bi-person-circle"></i>
    </button>

    <AccountPanel v-if="authStore.isAuthenticated" />
    <CommandPalette v-if="authStore.isAuthenticated" />

  </div>
</template>

<style>
.app-wrapper {
  --title-bar-height: 0px;
  --app-viewport-height: calc(100dvh - var(--title-bar-height));
  display: flex;
  min-height: 100vh;
  /* 100vh on mobile = viewport with the browser chrome hidden, taller than
     what's actually visible on load — pushes the bottom dock below the fold
     until the user scrolls. dvh tracks the real visible height instead. */
  min-height: 100dvh;
}

.electron-window {
  --title-bar-height: env(titlebar-area-height, 38px);
  padding-top: var(--title-bar-height);
}

.electron-mac {
  --title-bar-height: 38px;
  --title-bar-left: 80px;
}

.electron-title-bar {
  position: fixed;
  inset: 0 0 auto;
  z-index: 10000;
  height: var(--title-bar-height);
  background: #141416;
  box-shadow: inset 0 -1px rgba(255, 255, 255, 0.08);
  color: #e2e8f0;
  user-select: none;
}

.electron-title-bar-content {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 100%;
  margin-left: env(titlebar-area-x, var(--title-bar-left, 0px));
  width: env(titlebar-area-width, auto);
  padding-inline: 12px;
  font-size: 13px;
  font-weight: 700;
  -webkit-app-region: drag;
}

.global-account-btn {
  position: fixed;
  top: calc(var(--title-bar-height) + 1rem);
  right: 1rem;
  z-index: 1040;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border: none;
  border-radius: 12px;
  background: rgba(20, 20, 22, 0.75);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  color: rgba(255, 255, 255, 0.85);
  font-size: 1.9rem;
  cursor: pointer;
  transition: background 0.13s ease;
}

.global-account-btn:hover {
  background: rgba(20, 20, 22, 0.9);
}

/* Main content */
.main-content {
  flex: 1;
  min-width: 0;
  overflow: auto;
  background: #ffffff;
  display: flex;
  flex-direction: column;
}

.main-content.is-sliding {
  position: relative;
  overflow: hidden;
}

/* The dock's backdrop blur would be recomputed every frame while it moves;
   over the wallpaper gradient it looks the same without it. */
.main-content.is-sliding .dock {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

/* Out of flow so the incoming desktop takes the full space beside it. Needs
   to outrank DesktopSessionHost's scoped .launcher-wrapper { position: relative }. */
.main-content.is-sliding > .slide-leaving {
  position: absolute;
  inset: 0;
}

.main-content.is-desktop {
  background: #000000;
}

/* An overview page's dock (see dockRealm) floats over the page; the padding
   keeps it from covering the page's own content. */
#overview-dock {
  position: fixed;
  inset: var(--title-bar-height) 0 0;
  z-index: 1000;
  pointer-events: none;
}

/* The dock's own background is translucent — over the overview's navy it
   tints blue, so it's made solid here, the same color as on the desktop. */
#overview-dock .dock {
  background: rgb(20, 20, 22);
}

/* AppDock's mobile app icons belong on the desktop, not over the overview. */
#overview-dock .desktop-icon-grid {
  display: none;
}

/* The padding below can be taller than the dock (e.g. the mobile nav), so the
   strip it leaves matches OverviewGrid's background. */
.main-content:has(> #overview-dock .dock) { background: #0f172a; }
.main-content:has(> #overview-dock .dock-bottom) { padding-bottom: 4.5rem; }
.main-content:has(> #overview-dock .dock-left) { padding-left: 4.5rem; }
.main-content:has(> #overview-dock .dock-right) { padding-right: 4.5rem; }

@media (max-width: 767px) {
  .global-account-btn {
    top: calc(var(--title-bar-height) + 0.6rem);
    right: 0.6rem;
    width: 40px;
    height: 40px;
    font-size: 1.6rem;
  }
}
</style>
