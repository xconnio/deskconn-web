<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import type { DockPosition } from '@/stores/settings'
import { useCapabilitiesStore, type Capability } from '@/stores/capabilities'
import { useMachinesStore } from '@/stores/machines'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const props = defineProps<{ realm: string; focused: boolean; initialSection?: string }>()
// Saved with the window, so it reopens on the same section.
const emit = defineEmits<{ 'update-props': [props: { initialSection: string }] }>()

const settingsStore = useSettingsStore()
const capabilitiesStore = useCapabilitiesStore()
const machinesStore = useMachinesStore()

const capabilities = computed(() => capabilitiesStore.byRealm[props.realm] ?? [])
// The device enforces this too; here it only decides whether the switches are usable.
const canManageApps = computed(() => {
  const role = machinesStore.desktops.find((d) => d.realm === props.realm)?.role
  return role === 'owner' || role === 'admin'
})

const pendingId = ref<string | null>(null)
const appsError = ref('')
// An app others require, waiting on the user to confirm turning them all off.
const confirmDisable = ref<Capability | null>(null)

function nameOf(id: string): string {
  return capabilities.value.find((c) => c.id === id)?.name ?? id
}

function dependentsOf(app: Capability): Capability[] {
  return capabilities.value.filter((c) => c.requires.includes(app.id))
}

/** The first required app that's off, which blocks turning this one on. */
function missingRequirement(app: Capability): string | null {
  const id = app.requires.find((r) => !capabilitiesStore.isEnabled(props.realm, r))
  return id ? nameOf(id) : null
}

const confirmMessage = computed(() => {
  const app = confirmDisable.value
  if (!app) return ''
  const names = dependentsOf(app).map((c) => c.name)
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
  return `${list} need ${app.name}, so they'll be turned off too. To use them again, turn on ${app.name} first, then turn each of them back on.`
})

function onToggle(app: Capability, enabled: boolean, event: Event) {
  // Keep the switch showing the device's state until it confirms the change.
  ;(event.target as HTMLInputElement).checked = app.enabled
  if (!enabled && dependentsOf(app).some((c) => c.enabled)) {
    confirmDisable.value = app
    return
  }
  void applyToggle(app.id, enabled)
}

async function applyToggle(id: string, enabled: boolean) {
  confirmDisable.value = null
  pendingId.value = id
  appsError.value = ''
  try {
    await capabilitiesStore.set(props.realm, id, enabled)
  } catch (err) {
    appsError.value = (err as Error).message
  } finally {
    pendingId.value = null
  }
}

type Section = 'appearance' | 'apps'

const sections = computed(() => [
  { id: 'appearance' as const, label: 'Appearance', icon: 'bi-palette' },
  // Only once the device has listed its apps — older builds have none to manage.
  ...(capabilities.value.length ? [{ id: 'apps' as const, label: 'Apps', icon: 'bi-grid' }] : []),
])

// Not checked here: activeSection falls back to the first section for an unknown one.
const selectedSection = ref<Section>((props.initialSection as Section | undefined) ?? 'appearance')
watch(selectedSection, (id) => emit('update-props', { initialSection: id }))
const activeSection = computed(() =>
  sections.value.find((s) => s.id === selectedSection.value) ?? sections.value[0]!,
)

onMounted(() => {
  void capabilitiesStore.fetch(props.realm)
})
</script>

<template>
  <div class="desktop-settings">
    <aside class="desktop-settings-nav">
      <button
        v-for="section in sections"
        :key="section.id"
        class="desktop-settings-nav-item"
        :class="{ active: activeSection.id === section.id }"
        :title="section.label"
        @click="selectedSection = section.id"
      >
        <i class="bi" :class="section.icon"></i>
        <span class="desktop-settings-nav-label">{{ section.label }}</span>
      </button>
    </aside>

    <div class="desktop-settings-content">
      <div class="desktop-settings-inner">
        <h4 class="desktop-settings-title">{{ activeSection.label }}</h4>

        <div v-if="activeSection.id === 'appearance'" class="desktop-settings-card desktop-settings-row">
          <p class="mb-0 fw-semibold">Task bar position</p>
          <select
            class="form-select form-select-sm desktop-settings-select"
            :value="settingsStore.getDockPosition(props.realm)"
            @change="settingsStore.setDockPosition(props.realm, ($event.target as HTMLSelectElement).value as DockPosition)"
          >
            <option value="bottom">Bottom</option>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </div>

        <template v-else>
          <p v-if="!canManageApps" class="desktop-settings-note">
            Only this machine's owner or an admin can turn apps on or off.
          </p>

          <div class="desktop-settings-grid">
            <div v-for="app in capabilities" :key="app.id" class="desktop-settings-card desktop-settings-row">
              <div>
                <p class="mb-0 fw-semibold">{{ app.name }}</p>
                <p v-if="!app.enabled && missingRequirement(app)" class="desktop-settings-hint">
                  Requires {{ missingRequirement(app) }}. Turn on {{ missingRequirement(app) }} first.
                </p>
              </div>
              <div class="form-check form-switch mb-0">
                <input
                  class="form-check-input desktop-settings-switch"
                  type="checkbox"
                  role="switch"
                  :aria-label="`${app.name} enabled`"
                  :checked="app.enabled"
                  :disabled="!canManageApps || pendingId !== null || (!app.enabled && !!missingRequirement(app))"
                  @change="onToggle(app, ($event.target as HTMLInputElement).checked, $event)"
                />
              </div>
            </div>
          </div>

          <div v-if="appsError" class="alert alert-danger mt-3 mb-0 py-2 small">{{ appsError }}</div>
        </template>
      </div>
    </div>

    <ConfirmDialog
      :open="!!confirmDisable"
      :title="`Turn off ${confirmDisable?.name}?`"
      :message="confirmMessage"
      confirm-label="Turn off"
      @confirm="confirmDisable && applyToggle(confirmDisable.id, false)"
      @cancel="confirmDisable = null"
    />
  </div>
</template>

<style scoped>
/* A container, not the viewport: this is a resizable window, so the sidebar
   collapses to icons based on the window's own width. */
.desktop-settings {
  display: flex;
  height: 100%;
  background: #f4f5f7;
  container-type: inline-size;
}

.desktop-settings-nav {
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  padding: 1.25rem 0.6rem;
  background: #ebedf0;
  border-right: 1px solid #e2e4e8;
  overflow-y: auto;
}

.desktop-settings-nav-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border: none;
  background: transparent;
  color: #3d4652;
  font-weight: 600;
  font-size: 0.88rem;
  padding: 0.55rem 0.7rem;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
}

.desktop-settings-nav-item:hover {
  background: #dfe2e6;
}

.desktop-settings-nav-item.active {
  background: #d4d8de;
  color: #1e2328;
}

.desktop-settings-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 2rem 1.5rem;
}

.desktop-settings-inner {
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
}

@container (max-width: 560px) {
  .desktop-settings-nav {
    width: 56px;
    padding: 1rem 0.4rem;
  }

  .desktop-settings-nav-item {
    justify-content: center;
    padding: 0.6rem;
  }

  .desktop-settings-nav-item i {
    font-size: 1.1rem;
  }

  .desktop-settings-nav-label {
    display: none;
  }

  .desktop-settings-content {
    padding: 1.25rem 1rem;
  }
}

.desktop-settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.75rem;
}

.desktop-settings-title {
  margin: 0 0 1.25rem;
  font-size: 1.3rem;
  font-weight: 700;
  color: #1e2328;
}

.desktop-settings-card {
  background: #ffffff;
  border: 1px solid #e2e4e8;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  overflow: hidden;
}

.desktop-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem 1.1rem;
}

.desktop-settings-note {
  margin: -0.75rem 0 1rem;
  font-size: 0.85rem;
  color: #5f6b7a;
}

.desktop-settings-hint {
  margin: 0.15rem 0 0;
  font-size: 0.8rem;
  color: #5f6b7a;
}

.desktop-settings-switch {
  width: 2.5em;
  height: 1.3em;
  cursor: pointer;
}

.desktop-settings-select {
  width: 130px;
  flex-shrink: 0;
  cursor: pointer;
}
</style>
