<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import type { Session as WampSession } from 'xconn'
import GitFolderPicker from './GitFolderPicker.vue'
import { useSessionCacheStore } from '../stores/sessionCache'
import { useSessionEncryptionStore } from '../stores/sessionEncryption'
import type { EncryptionKeys } from '../utils/encryption'
import { formatDesktopError, isDesktopOfflineError } from '../utils/desktopError'
import { encryptedCall } from '../utils/encryptedCall'

// The coding agents' sessions (Claude, Codex), one agent at a time: each agent is its own
// app on the machine, with its own procedures, served while it's installed.
interface Agent {
  id: string
  label: string
  icon: string
  accent: string
}

const props = defineProps<{
  realm: string
  focused?: boolean
  agents: Agent[]
}>()
// Without a sessionId, starts a new session in dir.
const emit = defineEmits<{ 'resume-agent': [agent: string, dir: string, sessionId?: string] }>()

const sessionCacheStore = useSessionCacheStore()
const sessionEncryptionStore = useSessionEncryptionStore()

// deskconnd's <agent>.project.list and <agent>.session.list, shared with `desk agent`.
interface Project {
  path: string
  sessions: number
  updated_at: string
}

interface Session {
  session_id: string
  title: string
  updated_at: string
  messages?: { role: 'user' | 'assistant'; text: string }[]
}

const agentId = ref(props.agents[0]?.id)
// Falls back to another agent if this one's uninstalled while open.
const current = computed(() => props.agents.find((a) => a.id === agentId.value) ?? props.agents[0])

const projects = ref<Project[]>([])
const selected = ref<Project | null>(null)
const sessions = ref<Session[]>([])
const loading = ref(true)
const loadingSessions = ref(false)
const loadingMore = ref(false)
// Sessions are listed a page at a time: each one listed reads the end of its file.
const PAGE_SIZE = 20
const loaded = ref(0)
const hasMore = ref(false)
const error = ref<string | null>(null)

async function call<T>(procedure: string, arg?: unknown): Promise<T> {
  const session = await sessionCacheStore.acquire(props.realm)
  if (!session) throw new Error('Desktop is offline.')
  try {
    return await encryptedCall<T>(session, props.realm, procedure, arg)
  } catch (e) {
    if (isDesktopOfflineError(e)) sessionCacheStore.reportUnreachable(props.realm)
    throw e
  }
}

async function loadProjects() {
  const agent = current.value
  if (!agent) return
  loading.value = true
  error.value = null
  try {
    const list = await call<Project[]>(`io.xconn.deskconn.deskconnd.${agent.id}.project.list`)
    if (agent !== current.value) return
    projects.value = list
    const project = list.find((p) => p.path === selected.value?.path) ?? list[0]
    if (project) await selectProject(project)
  } catch (e) {
    if (agent === current.value) error.value = formatDesktopError(e)
  } finally {
    if (agent === current.value) loading.value = false
  }
}

function selectProject(project: Project) {
  selected.value = project
  sessions.value = []
  loaded.value = 0
  return loadSessions(project, loadingSessions)
}

async function loadSessions(project: Project, loadingFlag = loadingMore) {
  const agent = current.value!
  loadingFlag.value = true
  error.value = null
  try {
    const page = (await call<Session[] | null>(`io.xconn.deskconn.deskconnd.${agent.id}.session.list`, {
      path: project.path, offset: loaded.value, limit: PAGE_SIZE,
    })) ?? []
    if (selected.value !== project || agent !== current.value) return
    loaded.value += page.length
    hasMore.value = page.length === PAGE_SIZE
    // Sessions without any chat yet (only settings records) have nothing to resume. One in use
    // moves to the front while paging, so it can come again: it's shown once.
    const shown = new Set(sessions.value.map((s) => s.session_id))
    sessions.value.push(...page.filter((s) => s.messages?.length && !shown.has(s.session_id)))
  } catch (e) {
    error.value = formatDesktopError(e)
  } finally {
    loadingFlag.value = false
  }
}

// A folder picker for starting a session in a directory that has none yet.
const picker = shallowRef<{ session: WampSession; keys: EncryptionKeys } | null>(null)

async function openPicker() {
  error.value = null
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) throw new Error('Desktop is offline.')
    picker.value = { session, keys: await sessionEncryptionStore.getOrExchange(session, props.realm) }
  } catch (e) {
    error.value = formatDesktopError(e)
  }
}

function onPickFolder(path: string) {
  picker.value = null
  emit('resume-agent', current.value!.id, path)
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Each agent has its own projects: switching keeps the selected directory if the new one has it.
watch(() => current.value?.id, () => {
  projects.value = []
  sessions.value = []
  loadProjects()
}, { immediate: true })
</script>

<template>
  <div class="cp-root" :style="{ '--cp-accent': current?.accent }">
  <div class="cp-container">
  <div class="cp-tabs">
    <button
      v-for="a in agents"
      :key="a.id"
      class="cp-tab"
      :class="{ 'cp-tab--active': a.id === current?.id }"
      @click="agentId = a.id"
    >
      <i class="bi" :class="a.icon"></i> {{ a.label }}
    </button>
  </div>
  <div class="agent-panel">
    <div v-if="loading" class="cp-state"><span class="spinner-border spinner-border-sm"></span> Loading…</div>
    <div v-else-if="!projects.length" class="cp-state cp-state--column">
      <span><i class="bi" :class="current?.icon"></i> {{ error ?? `No ${current?.label} sessions on this machine yet.` }}</span>
      <button class="cp-resume" @click="openPicker"><i class="bi bi-folder-plus"></i> New session in folder…</button>
    </div>
    <template v-else>
      <nav class="cp-sidebar">
        <div class="cp-sidebar-head">
          <span>Directories</span>
          <span>
            <button class="cp-icon-btn" title="New session in folder…" @click="openPicker"><i class="bi bi-folder-plus"></i></button>
            <button class="cp-icon-btn" title="Refresh" @click="loadProjects"><i class="bi bi-arrow-clockwise"></i></button>
          </span>
        </div>
        <button
          v-for="p in projects"
          :key="p.path"
          class="cp-project"
          :class="{ 'cp-project--active': selected?.path === p.path }"
          :title="p.path"
          @click="selectProject(p)"
        >
          <span class="cp-project-name"><i class="bi bi-folder2"></i> {{ baseName(p.path) }}</span>
          <span class="cp-project-meta">{{ p.path }}</span>
          <span class="cp-project-meta">{{ p.sessions }} session{{ p.sessions === 1 ? '' : 's' }} · {{ ago(p.updated_at) }}</span>
        </button>
      </nav>

      <section class="cp-content">
        <header v-if="selected" class="cp-content-head">
          <span class="cp-project-meta" :title="selected.path">{{ selected.path }}</span>
          <button class="cp-resume" @click="emit('resume-agent', current!.id, selected.path)">
            <i class="bi bi-plus-lg"></i> New session
          </button>
        </header>
        <div v-if="error" class="cp-error"><i class="bi bi-exclamation-triangle"></i> {{ error }}</div>
        <div v-if="loadingSessions" class="cp-state"><span class="spinner-border spinner-border-sm"></span> Loading sessions…</div>
        <div v-else-if="!sessions.length && !error" class="cp-state">No sessions in this directory.</div>
        <article v-for="s in loadingSessions ? [] : sessions" :key="s.session_id" class="cp-session">
          <header class="cp-session-head">
            <div class="cp-session-title">
              <strong>{{ s.title || 'Untitled session' }}</strong>
              <span class="cp-project-meta">{{ ago(s.updated_at) }} · {{ s.session_id.slice(0, 8) }}</span>
            </div>
            <button class="cp-resume" @click="emit('resume-agent', current!.id, selected!.path, s.session_id)">
              <i class="bi bi-play-fill"></i> Resume
            </button>
          </header>
          <div v-for="(m, i) in s.messages" :key="i" class="cp-msg" :class="`cp-msg--${m.role}`">
            <span class="cp-msg-role">{{ m.role === 'user' ? 'You' : current?.label }}</span>
            <p>{{ m.text }}</p>
          </div>
        </article>
        <button
          v-if="hasMore && !loadingSessions"
          class="cp-more"
          :disabled="loadingMore"
          @click="loadSessions(selected!)"
        >
          {{ loadingMore ? 'Loading…' : 'Load more' }}
        </button>
      </section>
    </template>
  </div>
  </div>
  <!-- Outside .cp-container: its size containment would trap the fixed backdrop in the window. -->
  <GitFolderPicker
    v-if="picker"
    :session="picker.session"
    :keys="picker.keys"
    mode="open-folder"
    @confirm="onPickFolder"
    @cancel="picker = null"
  />
  </div>
</template>

<style scoped>
.cp-root {
  height: 100%;
}

.cp-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  container-type: inline-size;
  color-scheme: dark;
  scrollbar-color: #3a3a3a #000000;
}

.cp-tabs {
  display: flex;
  gap: 2px;
  padding: 0.3rem 0.4rem;
  background: #181818;
  border-bottom: 1px solid #333333;
}

.cp-tab {
  background: transparent;
  border: 0;
  border-radius: 6px;
  padding: 0.25rem 0.7rem;
  font-size: 0.78rem;
  font-weight: 600;
  color: #94a3b8;
  cursor: pointer;
}

.cp-tab:hover {
  background: #2a2a2a;
}

.cp-tab--active {
  background: color-mix(in srgb, var(--cp-accent) 22%, transparent);
  color: #e2e8f0;
}

.agent-panel {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #1e1e1e;
}

.cp-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  flex: 1;
  padding: 1rem;
  color: #94a3b8;
  font-size: 0.85rem;
  text-align: center;
}

.cp-state--column {
  flex-direction: column;
}

.cp-sidebar {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid #333333;
  background: #181818;
  padding: 0.4rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cp-sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.2rem 0.4rem 0.4rem;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #94a3b8;
}

.cp-icon-btn {
  background: transparent;
  border: 0;
  color: #94a3b8;
  cursor: pointer;
}

.cp-project {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: transparent;
  border: 0;
  border-radius: 8px;
  padding: 0.45rem 0.5rem;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.cp-project:hover {
  background: #2a2a2a;
}

.cp-project--active {
  background: color-mix(in srgb, var(--cp-accent) 22%, transparent);
}

.cp-project-name {
  font-size: 0.8rem;
  font-weight: 700;
  color: #e2e8f0;
}

.cp-project-meta {
  font-size: 0.68rem;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.cp-content-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.cp-more {
  align-self: center;
  background: #252526;
  color: #d4d4d4;
  border: 1px solid #3a3a3a;
  border-radius: 6px;
  padding: 0.3rem 0.9rem;
  font-size: 0.75rem;
  cursor: pointer;
}

.cp-more:hover:not(:disabled) {
  background: #2a2a2a;
}

.cp-error {
  background: #3b1d1d;
  color: #fca5a5;
  border: 1px solid #7f1d1d;
  border-radius: 8px;
  padding: 0.4rem 0.6rem;
  font-size: 0.75rem;
}

.cp-session {
  background: #252526;
  border: 1px solid #333333;
  border-radius: 10px;
  padding: 0.6rem 0.75rem;
}

.cp-session-head {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  margin-bottom: 0.4rem;
}

.cp-session-title {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  color: #f1f5f9;
}

.cp-resume {
  flex-shrink: 0;
  background: var(--cp-accent);
  color: #fff;
  border: 0;
  border-radius: 6px;
  padding: 0.25rem 0.65rem;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.cp-resume:hover {
  background: color-mix(in srgb, var(--cp-accent) 85%, #000);
}

.cp-msg {
  border-left: 2px solid #3a3a3a;
  padding: 0.1rem 0 0.1rem 0.5rem;
  margin-top: 0.3rem;
}

.cp-msg--user {
  border-left-color: var(--cp-accent);
}

.cp-msg-role {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  color: #8b949e;
}

.cp-msg p {
  margin: 0;
  font-size: 0.78rem;
  color: #d4d4d4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

@container (max-width: 560px) {
  .agent-panel {
    flex-direction: column;
  }
  .cp-sidebar {
    width: auto;
    max-height: 35%;
    border-right: 0;
    border-bottom: 1px solid #333333;
  }
}
</style>
