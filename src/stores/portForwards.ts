import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { get, set } from 'idb-keyval'
import { useSessionCacheStore } from './sessionCache'
import { dialLocal, listenLocal, openForward, startReverse } from '@/services/portStream'

export interface PortRule {
  id: string
  /** forward: localhost:localPort here → localhost:remotePort on the machine. reverse: the other way. */
  direction: 'forward' | 'reverse'
  localPort: number
  remotePort: number
}

export interface RuleState {
  status: 'stopped' | 'starting' | 'running' | 'disconnected'
  error?: string
  connections: number
}

const STORAGE_KEY = 'portForwards'

// Running rules' stop functions; not reactive.
const running = new Map<string, () => void>()

export const usePortForwardsStore = defineStore('portForwards', () => {
  /** Saved rules, by realm. */
  const rules = ref<Record<string, PortRule[]>>({})
  const states = reactive(new Map<string, RuleState>())
  const loaded = get<Record<string, PortRule[]>>(STORAGE_KEY)
    .then((saved) => { if (saved) rules.value = saved })
    .catch(() => {})

  function save() {
    // Plain copy: IndexedDB can't clone Vue proxies.
    set(STORAGE_KEY, JSON.parse(JSON.stringify(rules.value))).catch(() => {})
  }

  function state(id: string): RuleState {
    let s = states.get(id)
    if (!s) {
      s = { status: 'stopped', connections: 0 }
      states.set(id, s)
    }
    return states.get(id)!
  }

  async function add(realm: string, rule: Omit<PortRule, 'id'>) {
    await loaded
    const taken = (rules.value[realm] ?? []).some((r) => r.direction === rule.direction
      && (rule.direction === 'forward' ? r.localPort === rule.localPort : r.remotePort === rule.remotePort))
    if (taken) throw new Error('A rule for that port already exists')
    rules.value = { ...rules.value, [realm]: [...(rules.value[realm] ?? []), { ...rule, id: crypto.randomUUID() }] }
    save()
  }

  function remove(realm: string, id: string) {
    stop(id)
    states.delete(id)
    rules.value = { ...rules.value, [realm]: (rules.value[realm] ?? []).filter((r) => r.id !== id) }
    save()
  }

  function stop(id: string) {
    running.get(id)?.()
    running.delete(id)
    const s = state(id)
    s.status = 'stopped'
    s.connections = 0
  }

  async function start(realm: string, rule: PortRule) {
    const s = state(rule.id)
    if (s.status === 'running' || s.status === 'starting') return
    s.status = 'starting'
    s.error = undefined
    let stopped = false
    // Marks the rule disconnected if it ends without stop() being called.
    const lost = () => {
      if (stopped || running.get(rule.id) !== stopRule) return
      running.delete(rule.id)
      stopRule()
      s.status = 'disconnected'
      s.connections = 0
    }
    let cleanup = () => {}
    const stopRule = () => { stopped = true; cleanup() }
    try {
      const session = await useSessionCacheStore().acquire(realm)
      if (!session) throw new Error('Machine is unreachable')
      if (rule.direction === 'forward') {
        cleanup = await listenLocal(rule.localPort, (port) => {
          s.connections++
          openForward(session, realm, rule.remotePort, port)
            .catch((err: unknown) => { if (!stopped) s.error = err instanceof Error ? err.message : String(err) })
            .finally(() => { if (!stopped) s.connections-- })
        }).then((close) => () => { void close() })
      } else {
        const handle = await startReverse(session, realm, rule.remotePort, () => dialLocal(rule.localPort),
          (n) => { if (!stopped) s.connections = n })
        cleanup = handle.stop
        void handle.done.then(lost)
      }
      // stop() or remove() ran while we were starting; s.status is already 'stopped'.
      if (s.status !== 'starting') {
        stopRule()
        return
      }
      session.onDisconnect(lost)
      running.set(rule.id, stopRule)
      s.status = 'running'
    } catch (err) {
      stopRule()
      s.status = 'stopped'
      s.error = err instanceof Error ? err.message : String(err)
    }
  }

  return { rules, add, remove, start, stop, state }
})
