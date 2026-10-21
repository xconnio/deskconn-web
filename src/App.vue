<script setup lang="ts">
import { onMounted, onUnmounted, computed, watch, defineAsyncComponent } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'

import { machinesOverviewReturnRealm } from './router/index'
import { STANDALONE_REALM } from './config'
import { useAuthStore } from './stores/auth'
import { useMachinesStore } from './stores/machines'
import { useDesktopSessionsStore } from './stores/desktopSessions'
import { useSessionCacheStore } from './stores/sessionCache'
import { useAccountPanelStore } from './stores/accountPanel'
import AccountPanel from './components/AccountPanel.vue'

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

const renderedRealms = computed(() => {
  const set = new Set(desktopSessionsStore.knownRealms)
  if (activeRealm.value) set.add(activeRealm.value)
  if (dockRealm.value) set.add(dockRealm.value)
  return [...set].filter(
    (r) => r === activeRealm.value || r === dockRealm.value || desktopSessionsStore.hasOpenWindows(r),
  )
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
  <div class="app-wrapper">

    <!-- Main content -->
    <main class="main-content" :class="{ 'is-desktop': hasDarkBackground }">
      <RouterView />
      <div id="overview-dock"></div>
      <DesktopSessionHost
        v-for="r in renderedRealms"
        :key="r"
        :realm="r"
        :active="r === activeRealm"
        :dock-elsewhere="r === dockRealm"
        v-show="r === activeRealm"
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

  </div>
</template>

<style>
.app-wrapper {
  display: flex;
  min-height: 100vh;
  /* 100vh on mobile = viewport with the browser chrome hidden, taller than
     what's actually visible on load — pushes the bottom dock below the fold
     until the user scrolls. dvh tracks the real visible height instead. */
  min-height: 100dvh;
}

.global-account-btn {
  position: fixed;
  top: 1rem;
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

.main-content.is-desktop {
  background: #000000;
}

/* An overview page's dock (see dockRealm) floats over the page; the padding
   keeps it from covering the page's own content. */
#overview-dock {
  position: fixed;
  inset: 0;
  z-index: 1000;
  pointer-events: none;
}

/* The dock's own background is translucent — over the overview's navy it
   tints blue, so it's made solid here, the same color as on the desktop. */
#overview-dock .dock {
  background: rgb(20, 20, 22);
}

.main-content:has(> #overview-dock .dock-bottom) { padding-bottom: 4.5rem; }
.main-content:has(> #overview-dock .dock-left) { padding-left: 4.5rem; }
.main-content:has(> #overview-dock .dock-right) { padding-right: 4.5rem; }

@media (max-width: 767px) {
  .global-account-btn {
    top: 0.6rem;
    right: 0.6rem;
    width: 40px;
    height: 40px;
    font-size: 1.6rem;
  }
}
</style>
