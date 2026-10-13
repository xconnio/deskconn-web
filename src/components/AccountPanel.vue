<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAccountPanelStore, type AccountSection } from '@/stores/accountPanel'
import { useAuthStore } from '@/stores/auth'
import AccountInfoPanel from '@/components/AccountInfoPanel.vue'
import SettingsView from '@/views/SettingsView.vue'
import AccessManagementView from '@/views/AccessManagementView.vue'

const accountPanelStore = useAccountPanelStore()
const authStore = useAuthStore()
const router = useRouter()
const route = useRoute()

const allSections: { id: AccountSection; label: string; icon: string }[] = [
  { id: 'account', label: 'Account', icon: 'bi-person-circle' },
  { id: 'general', label: 'General Settings', icon: 'bi-gear' },
  { id: 'access', label: 'Access Management', icon: 'bi-shield-lock' },
]

// Account and access management live in the cloud; a standalone login has neither.
const sections = computed(() =>
  authStore.standalone ? allSections.filter((s) => s.id === 'general') : allSections,
)

const activeSection = computed(() =>
  sections.value.some((s) => s.id === accountPanelStore.activeSection)
    ? accountPanelStore.activeSection
    : 'general',
)

const activeSectionLabel = computed(() => sections.value.find((s) => s.id === activeSection.value)?.label)

// Access Management embeds real navigation (into a specific machine/org) —
// once that changes the underlying route, the popup would otherwise just
// keep covering it up, so close automatically instead.
watch(
  () => route.fullPath,
  () => {
    if (accountPanelStore.isOpen) accountPanelStore.close()
  },
)

async function handleLogout() {
  accountPanelStore.close()
  await authStore.logout()
  router.push('/login')
}

function onKeydown(e: KeyboardEvent) {
  if (!accountPanelStore.isOpen) return
  if (e.key === 'Escape') accountPanelStore.close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    class="account-overlay"
    v-show="accountPanelStore.isOpen"
    @click.self="accountPanelStore.close()"
    @contextmenu.prevent
  >
    <div class="account-modal">
      <aside class="account-nav">
        <div class="account-nav-header">User Settings</div>

        <button
          v-for="section in sections"
          :key="section.id"
          class="account-nav-item"
          :class="{ active: activeSection === section.id }"
          @click="accountPanelStore.activeSection = section.id"
        >
          <i class="bi" :class="section.icon"></i> {{ section.label }}
        </button>

        <div class="account-nav-spacer"></div>

        <button class="account-nav-logout" @click="handleLogout">
          <i class="bi bi-box-arrow-right"></i> Log Out
        </button>
      </aside>

      <div class="account-content">
        <div class="account-content-header">
          <h5 class="mb-0">{{ activeSectionLabel }}</h5>
          <button class="account-close" title="Close" @click="accountPanelStore.close()">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>

        <div class="account-content-body">
          <AccountInfoPanel v-if="activeSection === 'account'" />
          <SettingsView v-else-if="activeSection === 'general'" />
          <AccessManagementView v-else />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account-overlay {
  position: fixed;
  inset: 0;
  z-index: 2200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.75);
  padding: 2rem;
}

.account-modal {
  display: flex;
  width: min(880px, 100%);
  height: min(600px, 85vh);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.5);
}

.account-nav {
  width: 220px;
  flex-shrink: 0;
  background: #18191c;
  display: flex;
  flex-direction: column;
  padding: 1.5rem 0.75rem;
  gap: 0.15rem;
}

.account-nav-header {
  color: #80848e;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0 0.6rem 0.5rem;
}

.account-nav-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border: none;
  background: transparent;
  color: #b5bac1;
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.55rem 0.6rem;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
}

.account-nav-item:hover {
  background: #2b2d31;
  color: #f2f3f5;
}

.account-nav-item.active {
  background: #35373c;
  color: #ffffff;
}

.account-nav-spacer {
  flex: 1;
}

.account-nav-logout {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border: none;
  background: transparent;
  color: #f23f42;
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.55rem 0.6rem;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
}

.account-nav-logout:hover {
  background: rgba(242, 63, 66, 0.1);
}

.account-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  background: #ffffff;
}

.account-content-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #e8ecf0;
}

.account-content-header h5 {
  font-weight: 700;
  color: #0f172a;
}

.account-content-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1.5rem;
}

.account-close {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid #e8ecf0;
  background: #ffffff;
  color: #475569;
  font-size: 0.9rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.account-close:hover {
  background: #f1f5f9;
  color: #0f172a;
}

@media (max-width: 767px) {
  .account-overlay {
    padding: 0;
  }

  .account-modal {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  .account-nav {
    width: 76px;
    padding: 1.25rem 0.4rem;
    align-items: center;
  }

  .account-nav-header {
    display: none;
  }

  .account-nav-item,
  .account-nav-logout {
    font-size: 0;
    justify-content: center;
    padding: 0.6rem;
  }

  .account-nav-item i,
  .account-nav-logout i {
    font-size: 1.1rem;
  }
}
</style>
