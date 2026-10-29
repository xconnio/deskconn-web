<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { requestMachinesPicker } from '@/router/index'
import { openLauncher, openWindowsOverview } from '@/router/navigation'
import { useAuthStore } from '@/stores/auth'
import { useMachinesStore } from '@/stores/machines'
import { useAccountPanelStore } from '@/stores/accountPanel'
import { isMac, useCommandPaletteStore, type Command, type Shortcut } from '@/stores/commandPalette'

const store = useCommandPaletteStore()
const authStore = useAuthStore()
const machinesStore = useMachinesStore()
const accountPanelStore = useAccountPanelStore()
const route = useRoute()
const router = useRouter()

const query = ref('')
const selected = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)

const currentRealm = computed(() =>
  route.name === 'desktop-launcher' || route.name === 'desktop-windows'
    ? (route.params.realm as string)
    : null,
)

const currentMachineName = computed(
  () => machinesStore.desktops.find((d) => d.realm === currentRealm.value)?.name ?? null,
)

const globalCommands = computed<Command[]>(() => {
  const list: Command[] = []
  const realm = currentRealm.value
  if (realm && route.name !== 'desktop-windows') {
    list.push({ id: 'nav:windows', group: 'Navigation', label: 'Show all windows', icon: 'bi-grid', keywords: 'overview apps', run: () => openWindowsOverview(realm) })
  }
  if (realm && route.name !== 'desktop-launcher') {
    list.push({ id: 'nav:desktop', group: 'Navigation', label: 'Back to desktop', icon: 'bi-display', run: () => openLauncher(realm) })
  }
  if (route.name !== 'home') {
    list.push({ id: 'nav:machines', group: 'Navigation', label: 'All machines', icon: 'bi-hdd-network', keywords: 'picker overview', run: requestMachinesPicker })
  }
  const realms = machinesStore.desktops.map((d) => d.realm)
  if (realms.length > 1) {
    // Same wrap-around order as the dock's Machines wheel; from the Machines
    // page (no current one) next is the first, previous the last.
    const idx = realm ? realms.indexOf(realm) : -1
    const step = (dir: number) =>
      openLauncher(realms[idx === -1 ? (dir > 0 ? 0 : realms.length - 1) : (idx + dir + realms.length) % realms.length]!)
    list.push(
      { id: 'machine:next', group: 'Switch machine', label: 'Next machine', icon: 'bi-chevron-double-right', keywords: 'switch', shortcut: { code: 'BracketRight', alt: true, shift: true }, run: () => step(1) },
      { id: 'machine:prev', group: 'Switch machine', label: 'Previous machine', icon: 'bi-chevron-double-left', keywords: 'switch', shortcut: { code: 'BracketLeft', alt: true, shift: true }, run: () => step(-1) },
    )
  }
  for (const d of machinesStore.desktops) {
    if (d.realm === realm) continue
    list.push({ id: `machine:${d.realm}`, group: 'Switch machine', label: d.name, icon: 'bi-pc-display', keywords: `machine go ${d.realm}`, run: () => openLauncher(d.realm) })
  }
  if (!authStore.standalone) {
    list.push({ id: 'acct:account', group: 'Account', label: 'Account', icon: 'bi-person-circle', keywords: 'profile', run: () => accountPanelStore.open('account') })
  }
  list.push({ id: 'acct:general', group: 'Account', label: 'General settings', icon: 'bi-gear', keywords: 'preferences', run: () => accountPanelStore.open('general') })
  if (!authStore.standalone) {
    list.push({ id: 'acct:access', group: 'Account', label: 'Access management', icon: 'bi-shield-lock', keywords: 'organizations invites members', run: () => accountPanelStore.open('access') })
  }
  list.push({
    id: 'acct:logout',
    group: 'Account',
    label: 'Log out',
    icon: 'bi-box-arrow-right',
    keywords: 'sign out',
    run: async () => {
      await authStore.logout()
      router.push('/login')
    },
  })
  return list
})

const allCommands = computed(() => [
  ...(currentRealm.value ? (store.realmCommands[currentRealm.value] ?? []) : []),
  ...globalCommands.value,
])

// Every query word must appear in the label/group/keywords; label prefix
// matches rank first, then word-start matches, then anything else.
function score(cmd: Command, words: string[]): number {
  const label = cmd.label.toLowerCase()
  const hay = `${label} ${cmd.group.toLowerCase()} ${cmd.keywords?.toLowerCase() ?? ''}`
  if (!words.every((w) => hay.includes(w))) return -1
  const first = words[0]!
  if (label.startsWith(first)) return 3
  if (label.includes(` ${first}`)) return 2
  return label.includes(first) ? 1 : 0
}

const results = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return allCommands.value
  return allCommands.value
    .map((cmd, i) => ({ cmd, s: score(cmd, words), i }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.cmd)
})

// Groups are only shown while browsing — a ranked search reads better flat.
const sections = computed(() => {
  if (query.value.trim()) return [{ group: null as string | null, items: results.value }]
  const map = new Map<string, Command[]>()
  for (const cmd of results.value) {
    const arr = map.get(cmd.group) ?? []
    arr.push(cmd)
    map.set(cmd.group, arr)
  }
  return [...map].map(([group, items]) => ({ group: group as string | null, items }))
})

// Flat order matching what's rendered, for arrow-key navigation.
const flat = computed(() => sections.value.flatMap((s) => s.items))

watch(query, () => (selected.value = 0))

watch(
  () => store.isOpen,
  async (open) => {
    if (!open) return
    query.value = ''
    selected.value = 0
    await nextTick()
    inputRef.value?.focus()
  },
)

// Closing the palette while the route changes underneath (e.g. browser back)
watch(() => route.fullPath, () => (store.isOpen = false))

function close() {
  store.isOpen = false
}

function run(cmd: Command | undefined) {
  if (!cmd) return
  close()
  cmd.run()
}

function move(delta: number) {
  const n = flat.value.length
  if (!n) return
  selected.value = (selected.value + delta + n) % n
  nextTick(() => {
    listRef.value?.querySelector('.cp-item.active')?.scrollIntoView({ block: 'nearest' })
  })
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    run(flat.value[selected.value])
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

const KEY_LABELS: Record<string, string> = { BracketLeft: '[', BracketRight: ']' }

function shortcutKeys(s: Shortcut): string[] {
  return [
    ...(s.alt ? [isMac ? '⌥' : 'Alt'] : []),
    ...(s.shift ? [isMac ? '⇧' : 'Shift'] : []),
    KEY_LABELS[s.code] ?? s.code.replace(/^Key|^Digit/, ''),
  ]
}

function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  return e.code === s.code && e.altKey === !!s.alt && e.shiftKey === !!s.shift && !e.ctrlKey && !e.metaKey
}

// Capture phase so it fires before apps' own handlers (e.g. the file browser,
// or xterm turning Alt+] into an escape sequence).
// Ctrl/Cmd+Shift+K rather than plain K, which the terminal's shell uses (kill-line).
function onGlobalKeydown(e: KeyboardEvent) {
  if (!authStore.isAuthenticated) return
  const cmd = allCommands.value.find((c) => c.shortcut && matchesShortcut(e, c.shortcut))
  if (cmd) {
    e.preventDefault()
    e.stopPropagation()
    run(cmd)
    return
  }
  if (e.code !== 'KeyK' || !(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return
  e.preventDefault()
  e.stopPropagation()
  store.isOpen = !store.isOpen
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown, true))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown, true))
</script>

<template>
  <Transition name="cp">
    <div v-if="store.isOpen" class="cp-overlay" @mousedown.self="close" @contextmenu.prevent>
      <div class="cp-modal" role="dialog" aria-modal="true" aria-label="Command palette">
        <div v-if="currentMachineName" class="cp-context">
          <span class="cp-chip"><i class="bi bi-pc-display"></i> {{ currentMachineName }}</span>
        </div>
        <input
          ref="inputRef"
          v-model="query"
          class="cp-input"
          type="text"
          placeholder="Type a command or search…"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-controls="cp-list"
          :aria-activedescendant="flat[selected] ? `cp-${flat[selected]!.id}` : undefined"
          @keydown="onInputKeydown"
        />
        <div id="cp-list" ref="listRef" class="cp-list" role="listbox">
          <template v-for="section in sections" :key="section.group ?? 'results'">
            <div v-if="section.group" class="cp-group">{{ section.group }}</div>
            <div
              v-for="cmd in section.items"
              :id="`cp-${cmd.id}`"
              :key="cmd.id"
              class="cp-item"
              :class="{ active: flat[selected]?.id === cmd.id }"
              role="option"
              :aria-selected="flat[selected]?.id === cmd.id"
              @mousemove="selected = flat.indexOf(cmd)"
              @click="run(cmd)"
            >
              <span class="cp-icon" :style="cmd.iconBg ? { background: cmd.iconBg, color: '#fff' } : undefined">
                <i class="bi" :class="cmd.icon"></i>
              </span>
              <span class="cp-label">{{ cmd.label }}</span>
              <span v-if="query.trim()" class="cp-item-group">{{ cmd.group }}</span>
              <span v-if="cmd.shortcut || cmd.keys" class="cp-shortcut">
                <kbd v-for="k in cmd.shortcut ? shortcutKeys(cmd.shortcut) : cmd.keys" :key="k">{{ k }}</kbd>
              </span>
            </div>
          </template>
          <div v-if="!flat.length" class="cp-empty">No results</div>
        </div>
        <div class="cp-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.cp-overlay {
  position: fixed;
  inset: 0;
  z-index: 2300;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 14vh 1rem 1rem;
  background: rgba(0, 0, 0, 0.45);
}

.cp-modal {
  width: min(640px, 100%);
  max-height: min(480px, 76vh);
  display: flex;
  flex-direction: column;
  background: rgba(28, 29, 33, 0.97);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.4),
    0 24px 64px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  color: #e6e6e9;
}

.cp-context {
  padding: 0.75rem 1rem 0;
}

.cp-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: #a1a1aa;
  font-size: 0.75rem;
}

.cp-input {
  width: 100%;
  padding: 0.85rem 1rem;
  border: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  outline: none;
  background: transparent;
  color: #f4f4f5;
  font-size: 1.05rem;
}

.cp-input::placeholder {
  color: #6b6b74;
}

.cp-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.35rem;
}

.cp-group {
  padding: 0.6rem 0.65rem 0.3rem;
  color: #6b6b74;
  font-size: 0.72rem;
  font-weight: 600;
}

.cp-item {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  height: 40px;
  padding: 0 0.65rem;
  border-radius: 7px;
  cursor: pointer;
  font-size: 0.88rem;
  position: relative;
}

.cp-item.active {
  background: rgba(255, 255, 255, 0.07);
}

.cp-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 2px;
  border-radius: 2px;
  background: #8b8cf8;
}

.cp-icon {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: #a1a1aa;
  font-size: 0.85rem;
}

.cp-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-item-group {
  color: #6b6b74;
  font-size: 0.75rem;
}

.cp-shortcut {
  display: inline-flex;
  gap: 0.2rem;
}

.cp-shortcut kbd,
.cp-footer kbd {
  display: inline-block;
  min-width: 18px;
  padding: 0 0.3rem;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: #a1a1aa;
  font-family: inherit;
  font-size: 0.7rem;
  text-align: center;
}

.cp-empty {
  padding: 1.5rem;
  text-align: center;
  color: #6b6b74;
  font-size: 0.88rem;
}

.cp-footer {
  display: flex;
  gap: 1rem;
  padding: 0.5rem 1rem;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  color: #6b6b74;
  font-size: 0.72rem;
}

.cp-footer kbd {
  margin-right: 0.2rem;
}

.cp-enter-active,
.cp-leave-active {
  transition: opacity 0.12s ease;
}

.cp-enter-active .cp-modal,
.cp-leave-active .cp-modal {
  transition: transform 0.12s ease;
}

.cp-enter-from,
.cp-leave-to {
  opacity: 0;
}

.cp-enter-from .cp-modal,
.cp-leave-to .cp-modal {
  transform: scale(0.97);
}

@media (max-width: 767px) {
  .cp-overlay {
    padding-top: 8vh;
  }

  .cp-footer {
    display: none;
  }
}
</style>
