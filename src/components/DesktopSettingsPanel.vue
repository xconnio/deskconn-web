<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import type { DockPosition } from '@/stores/settings'
import { useCapabilitiesStore, type Capability } from '@/stores/capabilities'
import { useMachinesStore } from '@/stores/machines'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const props = defineProps<{ realm: string; focused: boolean }>()

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

onMounted(() => {
  void capabilitiesStore.fetch(props.realm)
})
</script>

<template>
  <div class="desktop-settings">
    <div class="desktop-settings-inner">
      <h4 class="desktop-settings-title">Appearance</h4>

      <div class="desktop-settings-card">
        <div class="desktop-settings-row">
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

        <hr class="desktop-settings-divider" />

        <div class="desktop-settings-row">
          <p class="mb-0 fw-semibold">Resource Monitor refresh interval</p>
          <select
            class="form-select form-select-sm desktop-settings-select"
            :value="settingsStore.getResourceMonitorInterval(props.realm)"
            @change="settingsStore.setResourceMonitorInterval(props.realm, parseInt(($event.target as HTMLSelectElement).value, 10))"
          >
            <option value="1">1 second</option>
            <option value="5">5 seconds</option>
            <option value="10">10 seconds</option>
            <option value="15">15 seconds</option>
            <option value="30">30 seconds</option>
            <option value="60">60 seconds</option>
          </select>
        </div>
      </div>

      <template v-if="capabilities.length">
        <h4 class="desktop-settings-title desktop-settings-title--section">Apps</h4>
        <p class="desktop-settings-note">
          {{
            canManageApps
              ? 'Turned-off apps are unavailable to everyone on this machine, including the desk CLI.'
              : "Only this machine's owner or an admin can turn apps on or off."
          }}
        </p>

        <div class="desktop-settings-card">
          <template v-for="(app, i) in capabilities" :key="app.id">
            <hr v-if="i > 0" class="desktop-settings-divider" />
            <div class="desktop-settings-row">
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
          </template>
        </div>

        <div v-if="appsError" class="alert alert-danger mt-3 mb-0 py-2 small">{{ appsError }}</div>
      </template>
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
.desktop-settings {
  display: flex;
  justify-content: center;
  height: 100%;
  overflow-y: auto;
  padding: 2.5rem 1.5rem;
  background: #f4f5f7;
}

.desktop-settings-inner {
  width: 100%;
  max-width: 420px;
}

.desktop-settings-title {
  margin: 0 0 1.25rem;
  text-align: center;
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

.desktop-settings-title--section {
  margin-top: 2rem;
  margin-bottom: 0.5rem;
}

.desktop-settings-note {
  margin: 0 0 1rem;
  text-align: center;
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

.desktop-settings-divider {
  margin: 0;
  border-color: #e8ecf0;
}

.desktop-settings-select {
  width: 130px;
  flex-shrink: 0;
  cursor: pointer;
}
</style>
