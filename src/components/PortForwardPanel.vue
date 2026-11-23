<script setup lang="ts">
import { computed, ref } from 'vue'
import { usePortForwardsStore, type PortRule } from '../stores/portForwards'

const props = defineProps<{ realm: string; desktopName?: string; focused?: boolean }>()

const store = usePortForwardsStore()
const rules = computed(() => store.rules[props.realm] ?? [])

const direction = ref<PortRule['direction']>('forward')
const localPort = ref<number | null>(null)
const remotePort = ref<number | null>(null)
const formError = ref('')

const validPort = (p: number | null): p is number => Number.isInteger(p) && p! >= 1 && p! <= 65535

async function add() {
  formError.value = ''
  if (!validPort(localPort.value) || !validPort(remotePort.value)) {
    formError.value = 'Ports must be between 1 and 65535'
    return
  }
  try {
    await store.add(props.realm, { direction: direction.value, localPort: localPort.value, remotePort: remotePort.value })
    localPort.value = null
    remotePort.value = null
  } catch (err) {
    formError.value = err instanceof Error ? err.message : String(err)
  }
}

const STATUS_LABEL = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', disconnected: 'Disconnected' }
</script>

<template>
  <div class="pf">
    <form class="pf-add" @submit.prevent="add">
      <select v-model="direction" class="form-select form-select-sm" aria-label="Direction">
        <option value="forward">Local → machine</option>
        <option value="reverse">Machine → local</option>
      </select>
      <input v-model.number="localPort" type="number" min="1" max="65535" class="form-control form-control-sm"
        placeholder="Local port" aria-label="Local port" required>
      <input v-model.number="remotePort" type="number" min="1" max="65535" class="form-control form-control-sm"
        :placeholder="`${desktopName ?? 'Machine'} port`" aria-label="Machine port" required>
      <button type="submit" class="btn btn-sm btn-primary"><i class="bi bi-plus-lg"></i> Add</button>
    </form>
    <p v-if="formError" class="pf-error">{{ formError }}</p>

    <p v-if="rules.length === 0" class="pf-empty">
      Forward a port on this computer to one on {{ desktopName ?? 'the machine' }}, or the other way round.
      Ports bind to localhost on this computer; on the machine, reverse forwards listen on all interfaces.
    </p>
    <table v-else class="pf-table">
      <thead>
        <tr><th>Forward</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="rule in rules" :key="rule.id">
          <td class="pf-route">
            <template v-if="rule.direction === 'forward'">
              localhost:{{ rule.localPort }} <i class="bi bi-arrow-right"></i> {{ desktopName ?? 'machine' }}:{{ rule.remotePort }}
            </template>
            <template v-else>
              {{ desktopName ?? 'machine' }}:{{ rule.remotePort }} <i class="bi bi-arrow-right"></i> localhost:{{ rule.localPort }}
            </template>
          </td>
          <td>
            <span class="pf-status" :class="`pf-status--${store.state(rule.id).status}`">
              {{ STATUS_LABEL[store.state(rule.id).status] }}
              <template v-if="store.state(rule.id).status === 'running'">
                · {{ store.state(rule.id).connections }} conn
              </template>
            </span>
            <div v-if="store.state(rule.id).error" class="pf-rule-error">{{ store.state(rule.id).error }}</div>
          </td>
          <td class="pf-actions">
            <button v-if="store.state(rule.id).status === 'running'" class="btn btn-sm btn-outline-secondary"
              title="Stop" aria-label="Stop" @click="store.stop(rule.id)"><i class="bi bi-stop-fill"></i></button>
            <button v-else class="btn btn-sm btn-outline-secondary" title="Start" aria-label="Start"
              :disabled="store.state(rule.id).status === 'starting'" @click="store.start(realm, rule)">
              <i class="bi bi-play-fill"></i>
            </button>
            <button class="btn btn-sm btn-outline-danger" title="Remove" aria-label="Remove"
              @click="store.remove(realm, rule.id)"><i class="bi bi-trash"></i></button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.pf {
  height: 100%;
  overflow-y: auto;
  background: #f8fafc;
  padding: 0.75rem;
  font-size: 0.8rem;
  color: #334155;
}

.pf-add {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.pf-add select { flex: 1 1 150px; }
.pf-add input { flex: 1 1 100px; }

.pf-error,
.pf-rule-error {
  color: #b91c1c;
  font-size: 0.72rem;
  margin: 0.3rem 0 0;
}

.pf-empty {
  margin: 1.5rem 0.5rem;
  color: #64748b;
  text-align: center;
}

.pf-table {
  width: 100%;
  margin-top: 0.75rem;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}

.pf-table th {
  font-size: 0.7rem;
  font-weight: 600;
  color: #64748b;
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid #e2e8f0;
}

.pf-table td {
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid #f1f5f9;
  vertical-align: middle;
}

.pf-route {
  font-family: ui-monospace, monospace;
  word-break: break-all;
}

.pf-status { font-weight: 600; }
.pf-status--running { color: #15803d; }
.pf-status--disconnected { color: #b45309; }
.pf-status--stopped,
.pf-status--starting { color: #64748b; }

.pf-actions {
  white-space: nowrap;
  text-align: right;
}

.pf-actions .btn + .btn { margin-left: 0.3rem; }
</style>
