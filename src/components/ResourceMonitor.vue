<script setup lang="ts">
import { ref, computed, inject, onMounted, onUnmounted, watch } from 'vue'
import { useSessionCacheStore } from '../stores/sessionCache'
import { useSettingsStore } from '../stores/settings'
import { floatingWindowMenuKey } from '../composables/floatingWindowToolbar'
import { formatDesktopError, isDesktopOfflineError } from '../utils/desktopError'
import { encryptedCall } from '../utils/encryptedCall'

const props = defineProps<{
  realm: string
  desktopName?: string
  focused?: boolean
}>()

const sessionCacheStore = useSessionCacheStore()
const settingsStore = useSettingsStore()
const menuHostRef = inject(floatingWindowMenuKey)
const menuTarget = computed(() => menuHostRef?.value ?? null)

interface NetworkInterface {
  name: string
  bytes_sent_ps: number
  bytes_recv_ps: number
}

interface CPUTimes {
  user: number
  system: number
  nice: number
  idle: number
  iowait: number
  irq: number
  softirq: number
  steal: number
}

interface DeviceInfo {
  cpu_model: string
  cpu_physical: number
  cpu_logical: number
  cpu_usages: number[]
  cpu_times: CPUTimes
  ram_total: number
  ram_free: number
  ram_used: number
  ram_buff_cache: number
  ram_available: number
  swap_total: number
  swap_free: number
  swap_used: number
  disk_used: number
  disk_free: number
  disk_total: number
  network_interfaces: NetworkInterface[]
}

interface ProcessInfo {
  pid: number
  name: string
  user: string
  cpu_percent: number
  mem_rss: number
  mem_percent: number
}

interface AppInfo {
  id: string
  name: string
  icon_name: string
  pids: number[]
  cpu_percent: number
  mem_rss: number
}

type Section = 'apps' | 'processes' | 'processor' | 'memory' | 'disk' | 'network'

const SECTIONS: { id: Section; label: string; icon: string; graph: boolean }[] = [
  { id: 'apps', label: 'Apps', icon: 'bi-grid-3x3-gap', graph: false },
  { id: 'processes', label: 'Processes', icon: 'bi-list-task', graph: false },
  { id: 'processor', label: 'Processor', icon: 'bi-cpu', graph: true },
  { id: 'memory', label: 'Memory', icon: 'bi-memory', graph: true },
  { id: 'disk', label: 'Disk', icon: 'bi-hdd', graph: true },
  { id: 'network', label: 'Network', icon: 'bi-diagram-3', graph: true },
]

const activeSection = ref<Section>('apps')

const info = ref<DeviceInfo | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const actionError = ref<string | null>(null)

const processList = ref<ProcessInfo[]>([])
const appList = ref<AppInfo[]>([])
const processSearch = ref('')

let intervalId: ReturnType<typeof setInterval> | null = null

const HISTORY_LEN = 30
const cpuHistory = ref<number[]>([])
const memHistory = ref<number[]>([])
const diskHistory = ref<number[]>([])
const netHistory = ref<number[]>([])

function pushHistory(arr: number[], value: number) {
  arr.push(value)
  if (arr.length > HISTORY_LEN) arr.shift()
}

async function fetchInfo() {
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) {
      error.value = 'No session available'
      return
    }
    info.value = await encryptedCall<DeviceInfo>(session, props.realm, 'io.xconn.deskconn.deskconnd.machine.info')
    error.value = null

    pushHistory(cpuHistory.value, cpuOverall.value)
    pushHistory(memHistory.value, ramUsedPct())
    pushHistory(diskHistory.value, diskUsedPct())
    const netTotal = (info.value.network_interfaces ?? []).reduce(
      (sum, iface) => sum + iface.bytes_sent_ps + iface.bytes_recv_ps,
      0,
    )
    pushHistory(netHistory.value, netTotal)
  } catch (e) {
    if (isDesktopOfflineError(e)) sessionCacheStore.reportUnreachable(props.realm)
    error.value = formatDesktopError(e)
  } finally {
    loading.value = false
  }
}

async function fetchProcesses() {
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) return
    processList.value = await encryptedCall<ProcessInfo[]>(
      session, props.realm, 'io.xconn.deskconn.deskconnd.process.list')
  } catch (e) {
    if (isDesktopOfflineError(e)) sessionCacheStore.reportUnreachable(props.realm)
    actionError.value = formatDesktopError(e)
  }
}

const iconCache = ref<Map<string, string>>(new Map())
const iconFailed = new Set<string>()

async function ensureIcon(iconName: string) {
  if (!iconName || iconCache.value.has(iconName) || iconFailed.has(iconName)) return
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) return
    const parsed = await encryptedCall<{ mime: string; data: string }>(
      session, props.realm, 'io.xconn.deskconn.deskconnd.app.icon', iconName)
    iconCache.value.set(iconName, `data:${parsed.mime};base64,${parsed.data}`)
  } catch {
    iconFailed.add(iconName)
  }
}

async function fetchApps() {
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) return
    appList.value = await encryptedCall<AppInfo[]>(session, props.realm, 'io.xconn.deskconn.deskconnd.app.list')
    for (const app of appList.value) {
      if (app.icon_name) void ensureIcon(app.icon_name)
    }
  } catch (e) {
    if (isDesktopOfflineError(e)) sessionCacheStore.reportUnreachable(props.realm)
    actionError.value = formatDesktopError(e)
  }
}

async function signalPids(pids: number[], signal: 'term' | 'kill') {
  if (!pids.length) return
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) return
    await encryptedCall(session, props.realm, 'io.xconn.deskconn.deskconnd.process.signal', { pids, signal })
    actionError.value = null
  } catch (e) {
    if (isDesktopOfflineError(e)) sessionCacheStore.reportUnreachable(props.realm)
    actionError.value = formatDesktopError(e)
  } finally {
    if (activeSection.value === 'processes') void fetchProcesses()
    else if (activeSection.value === 'apps') void fetchApps()
  }
}

function selectSection(id: Section) {
  activeSection.value = id
  if (id === 'processes') void fetchProcesses()
  else if (id === 'apps') void fetchApps()
}

function stopPolling() {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

function pollTick() {
  void fetchInfo()
  if (activeSection.value === 'processes') void fetchProcesses()
  else if (activeSection.value === 'apps') void fetchApps()
}

function startPolling() {
  stopPolling()
  pollTick()
  intervalId = setInterval(pollTick, settingsStore.getResourceMonitorInterval(props.realm) * 1000)
}

watch(
  () => settingsStore.getResourceMonitorInterval(props.realm),
  () => {
    startPolling()
  },
)

onMounted(startPolling)
onUnmounted(stopPolling)

function formatBytes(b: number): string {
  const unit = 1000
  if (b < unit) return `${b.toFixed(0)} B`
  if (b < unit * unit) return `${(b / unit).toFixed(1)} KB`
  if (b < unit * unit * unit) return `${(b / unit / unit).toFixed(1)} MB`
  return `${(b / unit / unit / unit).toFixed(2)} GB`
}

function formatBytesPS(bps: number): string {
  return formatBytes(bps) + '/s'
}

const cpuOverall = computed(() => {
  const usages = info.value?.cpu_usages
  if (!usages?.length) return 0
  return usages.reduce((a, b) => a + b, 0) / usages.length
})

function cpuColor(pct: number): string {
  if (pct < 50) return '#22c55e'
  if (pct < 80) return '#f59e0b'
  return '#ef4444'
}

function ramUsedPct(): number {
  if (!info.value?.ram_total) return 0
  return ((info.value.ram_total - info.value.ram_available) / info.value.ram_total) * 100
}

function swapUsedPct(): number {
  if (!info.value?.swap_total) return 0
  return (info.value.swap_used / info.value.swap_total) * 100
}

function diskUsedPct(): number {
  if (!info.value?.disk_total) return 0
  return (info.value.disk_used / info.value.disk_total) * 100
}

function sparklinePoints(history: number[], max: number, width = 100, height = 24): string {
  if (history.length < 2) return ''
  return history
    .map((v, i) => {
      const x = (i / (history.length - 1)) * width
      const y = height - (Math.min(v, max) / max) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function sparklinePercent(history: number[], width = 100, height = 24): string {
  return sparklinePoints(history, 100, width, height)
}

function sparklineAuto(history: number[], width = 100, height = 24): string {
  const max = Math.max(1, ...history)
  return sparklinePoints(history, max, width, height)
}

function navSparklinePoints(id: Section): string {
  switch (id) {
    case 'processor':
      return sparklinePercent(cpuHistory.value)
    case 'memory':
      return sparklinePercent(memHistory.value)
    case 'disk':
      return sparklinePercent(diskHistory.value)
    case 'network':
      return sparklineAuto(netHistory.value)
    default:
      return ''
  }
}

const filteredProcesses = computed(() => {
  const query = processSearch.value.trim().toLowerCase()
  const list = query
    ? processList.value.filter((p) => p.name.toLowerCase().includes(query))
    : processList.value
  return [...list].sort((a, b) => b.mem_rss - a.mem_rss)
})

interface ContextMenuTarget {
  kind: 'process' | 'app'
  process?: ProcessInfo
  app?: AppInfo
}

const contextMenuVisible = ref(false)
const contextMenuPos = ref<{ top: number; left: number } | null>(null)
const contextMenuTarget = ref<ContextMenuTarget | null>(null)

function openMenuAt(event: MouseEvent) {
  const menuWidth = 170
  const menuHeight = 96
  contextMenuPos.value = {
    top: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
    left: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
  }
  contextMenuVisible.value = true
}

function openProcessMenu(p: ProcessInfo, event: MouseEvent) {
  contextMenuTarget.value = { kind: 'process', process: p }
  openMenuAt(event)
}

function openAppMenu(a: AppInfo, event: MouseEvent) {
  if (a.id === 'system') return
  contextMenuTarget.value = { kind: 'app', app: a }
  openMenuAt(event)
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuPos.value = null
  contextMenuTarget.value = null
}

function contextMenuPids(): number[] {
  const target = contextMenuTarget.value
  if (!target) return []
  if (target.kind === 'process' && target.process) return [target.process.pid]
  if (target.kind === 'app' && target.app) return target.app.pids
  return []
}

const contextMenuLabel = computed(() => {
  const target = contextMenuTarget.value
  if (!target) return ''
  if (target.kind === 'process') return target.process?.name ?? ''
  return target.app?.name ?? ''
})

function handleEnd() {
  const pids = contextMenuPids()
  closeContextMenu()
  void signalPids(pids, 'term')
}

function handleKill() {
  const pids = contextMenuPids()
  closeContextMenu()
  void signalPids(pids, 'kill')
}
</script>

<template>
  <div class="resource-monitor">
    <Teleport :to="menuTarget ?? 'body'" :disabled="!menuTarget">
      <label v-if="menuTarget" class="rm-menu-interval">
        <span><i class="bi bi-arrow-repeat"></i> Refresh interval</span>
        <select
          class="form-select form-select-sm"
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
      </label>
    </Teleport>
    <div v-if="loading" class="rm-loading">
      <div class="spinner-border spinner-border-sm text-secondary" role="status"></div>
      <span>Loading stats…</span>
    </div>

    <div v-else-if="error" class="rm-error">
      <i class="bi bi-exclamation-triangle-fill"></i>
      {{ error }}
    </div>

    <template v-else-if="info">
      <nav class="rm-sidebar">
        <button
          v-for="s in SECTIONS"
          :key="s.id"
          class="rm-nav-item"
          :class="{ 'rm-nav-item--active': activeSection === s.id }"
          :aria-label="s.label"
          @click="selectSection(s.id)"
        >
          <span class="rm-nav-row">
            <i class="bi" :class="s.icon"></i>
            <span class="rm-nav-label">{{ s.label }}</span>
          </span>
          <svg
            v-if="s.graph"
            viewBox="0 0 100 24"
            preserveAspectRatio="none"
            class="rm-nav-spark"
          >
            <polyline :points="navSparklinePoints(s.id)" />
          </svg>
        </button>
      </nav>

      <div class="rm-content">
        <div v-if="actionError" class="rm-action-error">
          <i class="bi bi-exclamation-triangle-fill"></i>
          <span>{{ actionError }}</span>
          <button class="rm-action-error-close" @click="actionError = null">
            <i class="bi bi-x"></i>
          </button>
        </div>

        <!-- Apps -->
        <section v-if="activeSection === 'apps'" class="rm-detail">
          <div class="rm-detail-header">
            <span class="rm-detail-title"><i class="bi bi-grid-3x3-gap"></i> Apps</span>
          </div>
          <div v-if="!appList.length" class="rm-empty">No apps found.</div>
          <div v-else class="rm-list">
            <div class="rm-list-header rm-app-row">
              <span>App</span>
              <span class="rm-col-num">Memory</span>
              <span class="rm-col-num">Processor</span>
            </div>
            <div
              v-for="app in appList"
              :key="app.id"
              class="rm-list-row rm-app-row"
              @contextmenu.prevent="openAppMenu(app, $event)"
            >
              <span class="rm-row-name">
                <span class="rm-icon">
                  <img v-if="iconCache.get(app.icon_name)" :src="iconCache.get(app.icon_name)" alt="" />
                  <i v-else class="bi bi-app-indicator"></i>
                </span>
                {{ app.name }}
              </span>
              <span class="rm-col-num">{{ formatBytes(app.mem_rss) }}</span>
              <span class="rm-col-num">{{ app.cpu_percent.toFixed(1) }}%</span>
            </div>
          </div>
        </section>

        <!-- Processes -->
        <section v-else-if="activeSection === 'processes'" class="rm-detail">
          <div class="rm-detail-header">
            <span class="rm-detail-title"><i class="bi bi-list-task"></i> Processes</span>
          </div>
          <input
            v-model="processSearch"
            type="text"
            class="rm-search"
            placeholder="Search processes…"
          />
          <div v-if="!filteredProcesses.length" class="rm-empty">No processes found.</div>
          <div v-else class="rm-list">
            <div class="rm-list-header rm-proc-row">
              <span>Process</span>
              <span class="rm-col-num">PID</span>
              <span>User</span>
              <span class="rm-col-num">Memory</span>
              <span class="rm-col-num">CPU</span>
            </div>
            <div
              v-for="p in filteredProcesses"
              :key="p.pid"
              class="rm-list-row rm-proc-row"
              @contextmenu.prevent="openProcessMenu(p, $event)"
            >
              <span class="rm-row-name">
                <span class="rm-icon"><i class="bi bi-gear"></i></span>
                {{ p.name }}
              </span>
              <span class="rm-col-num">{{ p.pid }}</span>
              <span class="rm-row-user">{{ p.user }}</span>
              <span class="rm-col-num">{{ formatBytes(p.mem_rss) }}</span>
              <span class="rm-col-num">{{ p.cpu_percent.toFixed(1) }}%</span>
            </div>
          </div>
        </section>

        <!-- Processor -->
        <section v-else-if="activeSection === 'processor'" class="rm-detail">
          <div class="rm-detail-header">
            <span class="rm-detail-title"><i class="bi bi-cpu"></i> Processor</span>
            <span class="rm-detail-value" :style="{ color: cpuColor(cpuOverall) }">
              {{ cpuOverall.toFixed(1) }}%
            </span>
          </div>
          <p v-if="info.cpu_model" class="rm-model-name">{{ info.cpu_model }}</p>

          <div class="rm-options-row">
            <span>Show Usages of Logical CPUs</span>
            <label class="rm-switch">
              <input
                type="checkbox"
                :checked="settingsStore.showLogicalCpus"
                @change="settingsStore.setShowLogicalCpus(($event.target as HTMLInputElement).checked)"
              />
              <span class="rm-switch-track"><span class="rm-switch-thumb"></span></span>
            </label>
          </div>

          <template v-if="settingsStore.showLogicalCpus">
            <span class="rm-section-badge">{{ info.cpu_physical }}P / {{ info.cpu_logical }}L</span>
            <div class="rm-cores-grid">
              <div v-for="(usage, i) in info.cpu_usages" :key="i" class="rm-core-row">
                <span class="rm-core-label">CPU {{ i }}</span>
                <div class="rm-core-track">
                  <div
                    class="rm-core-fill"
                    :style="{ width: usage + '%', background: cpuColor(usage) }"
                  ></div>
                </div>
                <span class="rm-core-pct" :style="{ color: cpuColor(usage) }"
                  >{{ usage.toFixed(0) }}%</span
                >
              </div>
            </div>
          </template>
          <template v-else>
            <div class="rm-graph-card">
              <svg viewBox="0 0 300 80" preserveAspectRatio="none" class="rm-graph-svg">
                <polyline :points="sparklinePercent(cpuHistory, 300, 80)" />
              </svg>
              <div class="rm-graph-label">Total Usage · {{ cpuOverall.toFixed(1) }}%</div>
            </div>
          </template>
        </section>

        <!-- Memory -->
        <section v-else-if="activeSection === 'memory'" class="rm-detail">
          <div class="rm-detail-header">
            <span class="rm-detail-title"><i class="bi bi-memory"></i> Memory</span>
            <span class="rm-detail-value rm-value--blue">
              {{ formatBytes(info.ram_total - info.ram_available) }} /
              {{ formatBytes(info.ram_total) }}
            </span>
          </div>
          <div class="rm-graph-card">
            <svg viewBox="0 0 300 80" preserveAspectRatio="none" class="rm-graph-svg rm-graph-svg--blue">
              <polyline :points="sparklinePercent(memHistory, 300, 80)" />
            </svg>
            <div class="rm-graph-label">Used · {{ ramUsedPct().toFixed(1) }}%</div>
          </div>
          <div class="rm-bar">
            <div class="rm-bar-fill rm-bar-fill--blue" :style="{ width: ramUsedPct() + '%' }"></div>
          </div>
          <div class="rm-detail-row">
            <span>Available: {{ formatBytes(info.ram_available) }}</span>
            <span>Buff/Cache: {{ formatBytes(info.ram_buff_cache) }}</span>
          </div>
          <div v-if="info.swap_total > 0" class="rm-swap-row">
            <span class="rm-swap-label">Swap</span>
            <div class="rm-bar rm-bar--thin">
              <div
                class="rm-bar-fill rm-bar-fill--violet"
                :style="{ width: swapUsedPct() + '%' }"
              ></div>
            </div>
            <span class="rm-swap-val"
              >{{ formatBytes(info.swap_used) }} / {{ formatBytes(info.swap_total) }}</span
            >
          </div>
        </section>

        <!-- Disk -->
        <section v-else-if="activeSection === 'disk'" class="rm-detail">
          <div class="rm-detail-header">
            <span class="rm-detail-title"><i class="bi bi-hdd"></i> Disk (/)</span>
            <span class="rm-detail-value rm-value--violet">
              {{ formatBytes(info.disk_used) }} / {{ formatBytes(info.disk_total) }}
            </span>
          </div>
          <div class="rm-graph-card">
            <svg viewBox="0 0 300 80" preserveAspectRatio="none" class="rm-graph-svg rm-graph-svg--violet">
              <polyline :points="sparklinePercent(diskHistory, 300, 80)" />
            </svg>
            <div class="rm-graph-label">Used · {{ diskUsedPct().toFixed(1) }}%</div>
          </div>
          <div class="rm-bar">
            <div
              class="rm-bar-fill rm-bar-fill--violet"
              :style="{ width: diskUsedPct() + '%' }"
            ></div>
          </div>
          <div class="rm-detail-row">
            <span>Free: {{ formatBytes(info.disk_free) }}</span>
            <span>Used: {{ diskUsedPct().toFixed(1) }}%</span>
          </div>
        </section>

        <!-- Network -->
        <section v-else-if="activeSection === 'network'" class="rm-detail">
          <div class="rm-detail-header">
            <span class="rm-detail-title"><i class="bi bi-diagram-3"></i> Network</span>
          </div>
          <div class="rm-graph-card">
            <svg viewBox="0 0 300 80" preserveAspectRatio="none" class="rm-graph-svg rm-graph-svg--teal">
              <polyline :points="sparklineAuto(netHistory, 300, 80)" />
            </svg>
          </div>
          <div v-if="!info.network_interfaces?.length" class="rm-empty">No network interfaces.</div>
          <div v-else class="rm-net-list">
            <div v-for="iface in info.network_interfaces" :key="iface.name" class="rm-net-row">
              <span class="rm-net-name">{{ iface.name }}</span>
              <span class="rm-net-stat rm-net-up">
                <i class="bi bi-arrow-up-short"></i>{{ formatBytesPS(iface.bytes_sent_ps) }}
              </span>
              <span class="rm-net-stat rm-net-down">
                <i class="bi bi-arrow-down-short"></i>{{ formatBytesPS(iface.bytes_recv_ps) }}
              </span>
            </div>
          </div>
        </section>
      </div>
    </template>

    <div v-if="contextMenuVisible && contextMenuPos" class="dropdown-backdrop" @click="closeContextMenu">
      <div
        class="entry-dropdown"
        :style="{ top: contextMenuPos.top + 'px', left: contextMenuPos.left + 'px' }"
        @click.stop
      >
        <div class="dropdown-target-label">{{ contextMenuLabel }}</div>
        <button class="dropdown-item" @click="handleEnd">
          <i class="bi bi-x-circle"></i>End
        </button>
        <button class="dropdown-item dropdown-item-danger" @click="handleKill">
          <i class="bi bi-x-octagon-fill"></i>Kill
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rm-menu-interval {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin: 0;
  padding: 0.3rem 0.5rem;
  font-size: 0.8rem;
  font-weight: 500;
  color: #334155;
  white-space: nowrap;
}

.rm-menu-interval span {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.rm-menu-interval select {
  width: auto;
  font-size: 0.75rem;
  padding-top: 0.15rem;
  padding-bottom: 0.15rem;
}

.resource-monitor {
  display: flex;
  height: 100%;
  overflow: hidden;
  background: #f8fafc;
}

.rm-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  flex: 1;
  color: #64748b;
  font-size: 0.85rem;
}

.rm-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  flex: 1;
  color: #b45309;
  font-size: 0.85rem;
}

/* ── Sidebar ── */
.rm-sidebar {
  width: 152px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid #e2e8f0;
  background: #f1f5f9;
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rm-nav-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  padding: 0.4rem 0.5rem;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}

.rm-nav-item:hover {
  background: #e2e8f0;
}

.rm-nav-item--active {
  background: #dbeafe;
}

.rm-nav-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #334155;
}

.rm-nav-row .bi {
  font-size: 0.85rem;
  color: #64748b;
}

.rm-nav-spark {
  width: 100%;
  height: 20px;
}

.rm-nav-spark polyline {
  fill: none;
  stroke: #3b82f6;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

/* ── Content ── */
.rm-content {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
}

.rm-action-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: #fef2f2;
  color: #b91c1c;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  font-size: 0.72rem;
  margin-bottom: 0.6rem;
}

.rm-action-error-close {
  margin-left: auto;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
}

.rm-detail {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.7rem 0.85rem;
}

.rm-detail-header {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.45rem;
}

.rm-detail-title {
  font-size: 0.8rem;
  font-weight: 700;
  color: #334155;
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex: 1;
}

.rm-detail-title .bi {
  font-size: 0.9rem;
  color: #64748b;
}

.rm-detail-value {
  font-size: 0.78rem;
  font-weight: 700;
  color: #334155;
}

.rm-value--blue {
  color: #2563eb;
}
.rm-value--violet {
  color: #7c3aed;
}

.rm-model-name {
  font-size: 0.65rem;
  color: #94a3b8;
  margin: 0 0 0.4rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rm-options-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
  font-weight: 600;
  color: #334155;
  background: #f1f5f9;
  border-radius: 8px;
  padding: 0.5rem 0.65rem;
  margin-bottom: 0.6rem;
}

.rm-switch {
  position: relative;
  display: inline-block;
}

.rm-switch input {
  position: absolute;
  opacity: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  cursor: pointer;
}

.rm-switch-track {
  display: block;
  width: 34px;
  height: 18px;
  border-radius: 9px;
  background: #cbd5e1;
  transition: background 0.15s;
  position: relative;
}

.rm-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}

.rm-switch input:checked + .rm-switch-track {
  background: #3b82f6;
}

.rm-switch input:checked + .rm-switch-track .rm-switch-thumb {
  transform: translateX(16px);
}

.rm-section-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 600;
  color: #94a3b8;
  background: #f1f5f9;
  border-radius: 4px;
  padding: 1px 6px;
  margin-bottom: 0.4rem;
}

.rm-graph-card {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 0.5rem;
  margin-bottom: 0.6rem;
}

.rm-graph-svg {
  width: 100%;
  height: 80px;
  display: block;
}

.rm-graph-svg polyline {
  fill: none;
  stroke: #3b82f6;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.rm-graph-svg--blue polyline {
  stroke: #2563eb;
}
.rm-graph-svg--violet polyline {
  stroke: #7c3aed;
}
.rm-graph-svg--teal polyline {
  stroke: #0891b2;
}

.rm-graph-label {
  font-size: 0.68rem;
  color: #64748b;
  margin-top: 0.3rem;
}

.rm-bar {
  height: 18px;
  background: #e2e8f0;
  border-radius: 5px;
  overflow: hidden;
  margin-bottom: 0.4rem;
}

.rm-bar--thin {
  height: 5px;
  flex: 1;
  margin-bottom: 0;
}

.rm-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease;
}

.rm-bar-fill--blue {
  background: #3b82f6;
}
.rm-bar-fill--violet {
  background: #8b5cf6;
}

.rm-cores-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px 14px;
}

.rm-core-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.rm-core-label {
  font-size: 0.67rem;
  font-weight: 600;
  color: #64748b;
  min-width: 36px;
  flex-shrink: 0;
}

.rm-core-track {
  flex: 1;
  height: 14px;
  background: #e2e8f0;
  border-radius: 3px;
  overflow: hidden;
}

.rm-core-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}

.rm-core-pct {
  font-size: 0.67rem;
  font-weight: 700;
  min-width: 30px;
  text-align: right;
  flex-shrink: 0;
}

.rm-detail-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.65rem;
  color: #94a3b8;
  margin-top: 0.1rem;
}

.rm-swap-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.rm-swap-label {
  font-size: 0.65rem;
  font-weight: 600;
  color: #94a3b8;
  flex-shrink: 0;
}

.rm-swap-val {
  font-size: 0.65rem;
  color: #94a3b8;
  flex-shrink: 0;
}

.rm-net-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.rm-net-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.rm-net-name {
  font-size: 0.72rem;
  font-weight: 600;
  color: #334155;
  min-width: 60px;
  font-family: monospace;
}

.rm-net-stat {
  font-size: 0.68rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 1px;
  min-width: 80px;
}

.rm-net-up {
  color: #0891b2;
}

.rm-net-down {
  color: #059669;
}

.rm-empty {
  font-size: 0.75rem;
  color: #94a3b8;
  padding: 1rem 0;
  text-align: center;
}

/* ── Apps / Processes lists ── */
.rm-search {
  width: 100%;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  font-size: 0.78rem;
  margin-bottom: 0.55rem;
  outline: none;
}

.rm-search:focus {
  border-color: #93c5fd;
}

.rm-list {
  display: flex;
  flex-direction: column;
}

.rm-list-header {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: #94a3b8;
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid #e2e8f0;
}

/* Long-press opens the row menu on touch; don't let it start a text selection instead. */
@media (pointer: coarse) {
  .rm-list-row {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
}

.rm-list-row {
  padding: 0.4rem;
  border-bottom: 1px solid #f1f5f9;
  font-size: 0.76rem;
  color: #334155;
  cursor: default;
}

.rm-list-row:hover {
  background: #f8fafc;
}

.rm-app-row {
  display: grid;
  grid-template-columns: 1fr 90px 90px;
  align-items: center;
  gap: 0.4rem;
}

.rm-proc-row {
  display: grid;
  grid-template-columns: 1fr 70px 90px 90px 70px;
  align-items: center;
  gap: 0.4rem;
}

.rm-col-num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.rm-row-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rm-row-user {
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rm-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  overflow: hidden;
  background: #f1f5f9;
  color: #94a3b8;
}

.rm-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* Mobile: the 152px side rail leaves barely any room for content on a phone
   width, and the 5-column process grid doesn't fit at all — rail becomes a
   horizontal tab strip (sparkline previews dropped, each section's own graph
   already shows that), and the process row drops its least essential column. */
@media (max-width: 575.98px) {
  .resource-monitor {
    flex-direction: column;
  }

  .rm-sidebar {
    width: auto;
    flex-direction: row;
    border-right: none;
    border-bottom: 1px solid #e2e8f0;
  }

  /* Evenly-filled single row of tabs — sparkline previews dropped (each
     section's own graph already shows that) to keep every tab's label
     readable without needing to scroll to see the rest. */
  .rm-nav-item {
    flex: 1;
    align-items: center;
    padding: 0.45rem 0.2rem;
  }

  /* Icon above, label below — row's default is side-by-side. */
  .rm-nav-row {
    flex-direction: column;
    gap: 1px;
  }

  .rm-nav-spark {
    display: none;
  }

  .rm-nav-label {
    font-size: 0.65rem;
  }

  .rm-nav-row .bi {
    font-size: 1.05rem;
  }

  .rm-list-row {
    padding: 0.55rem 0.4rem;
  }

  .rm-app-row {
    grid-template-columns: 1fr 66px 66px;
  }

  .rm-proc-row {
    grid-template-columns: 1fr 55px 70px 55px;
  }

  /* Drop the User column — Process/Memory/CPU matter more at this width. */
  .rm-proc-row > *:nth-child(3) {
    display: none;
  }
}

/* ── Context menu ── */
.dropdown-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2000;
}

.entry-dropdown {
  position: fixed;
  z-index: 2001;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14), 0 2px 8px rgba(0, 0, 0, 0.07);
  border: 1px solid rgba(0, 0, 0, 0.08);
  min-width: 152px;
  padding: 0.3rem;
  animation: dropdown-pop 0.13s ease;
}

@keyframes dropdown-pop {
  from {
    transform: scale(0.88) translateY(-4px);
    opacity: 0;
  }
  to {
    transform: scale(1) translateY(0);
    opacity: 1;
  }
}

.dropdown-target-label {
  font-size: 0.68rem;
  font-weight: 700;
  color: #94a3b8;
  padding: 0.3rem 0.6rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dropdown-item {
  width: 100%;
  text-align: left;
  padding: 0.55rem 0.7rem;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #21313f;
  font-size: 0.85rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  transition: background 0.12s;
  cursor: pointer;
}

.dropdown-item:hover {
  background: #f1f5f9;
}

.dropdown-item-danger {
  color: #dc2626;
}

.dropdown-item-danger:hover {
  background: #fef2f2;
}
</style>
