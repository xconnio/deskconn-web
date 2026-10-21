import { ref } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import VerifyView from '../views/VerifyView.vue'
import MachinesOverview from '../components/MachinesOverview.vue'
import { useAuthStore } from '../stores/auth'
import { useSettingsStore } from '../stores/settings'

const router = createRouter({
  history: createWebHistory('/'),
  routes: [
    {
      path: '/',
      name: 'home',
      component: MachinesOverview,
      meta: { requiresAuth: true },
    },
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { requiresGuest: true },
    },
    {
      path: '/register',
      name: 'register',
      component: RegisterView,
      meta: { requiresGuest: true },
    },
    {
      path: '/verify',
      name: 'verify',
      component: VerifyView,
      meta: { requiresGuest: true },
    },
    {
      path: '/forgot-password',
      name: 'forgot-password',
      component: () => import('../views/ForgotPasswordView.vue'),
      meta: { requiresGuest: true },
    },
    {
      path: '/machine/:realm',
      name: 'desktop-launcher',
      component: () => import('../views/LauncherView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/machine/:realm/files',
      name: 'desktop-files',
      component: () => import('../views/DesktopFilesView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/machine/:realm/index/:category',
      name: 'desktop-index',
      component: () => import('../views/IndexedFilesView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/machine/:realm/windows',
      name: 'desktop-windows',
      component: () => import('../views/WindowsOverviewView.vue'),
      meta: { requiresAuth: true },
    },
  ],
})

// Explicitly requesting the Machines picker (e.g. the dock's Machines
// button) clears the last-used realm first, so the redirect below doesn't
// bounce this navigation straight back to the machine it came from — and,
// since it's persisted, reopening the app later (even a fresh browser
// session) lands back on the picker too, instead of jumping into a machine.
export function requestMachinesPicker() {
  useSettingsStore().clearLastRealm()
  router.push('/')
}

// The auto-redirect below only ever fires once per page load (browser open
// or refresh) — otherwise every later trip back to '/' (pressing Back from
// a machine, clicking the Machines button) would immediately bounce right
// back into whatever machine is currently the last-used one.
let hasResolvedHome = false

// The desktop MachinesOverview was navigated away from, if any — lets it show
// a close/back-to-desktop control instead of always being a dead-end page.
export const machinesOverviewReturnRealm = ref<string | null>(null)

router.beforeEach((to, from, next) => {
  const authStore = useAuthStore()

  if (to.path === '/') {
    machinesOverviewReturnRealm.value =
      from.name === 'desktop-launcher' || from.name === 'desktop-windows' ? (from.params.realm as string) : null
  }

  if (to.meta.requiresAuth && !authStore.isAuthenticated) {
    next('/login')
  } else if (to.meta.requiresGuest && authStore.isAuthenticated) {
    next('/')
  } else if (to.path === '/' && authStore.isAuthenticated) {
    // Skip the machine picker entirely when a last-used machine is known —
    // it becomes the landing page instead of MachinesOverview.
    const lastRealm = useSettingsStore().lastRealm
    if (lastRealm && !hasResolvedHome) {
      hasResolvedHome = true
      next({ name: 'desktop-launcher', params: { realm: lastRealm } })
    } else {
      hasResolvedHome = true
      next()
    }
  } else {
    next()
  }
})

export default router
