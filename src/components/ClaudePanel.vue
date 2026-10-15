<script setup lang="ts">
import { ref, shallowRef, onMounted } from 'vue'
import type { Session as WampSession } from 'xconn'
import GitFolderPicker from './GitFolderPicker.vue'
import { useSessionCacheStore } from '../stores/sessionCache'
import { useSessionEncryptionStore } from '../stores/sessionEncryption'
import type { EncryptionKeys } from '../utils/encryption'
import { formatDesktopError, isDesktopOfflineError } from '../utils/desktopError'
import { encryptedCall } from '../utils/encryptedCall'

const props = defineProps<{ realm: string; focused?: boolean }>()
// Without a sessionId, starts a new session in dir.
const emit = defineEmits<{ 'resume-claude': [dir: string, sessionId?: string] }>()

const sessionCacheStore = useSessionCacheStore()
const sessionEncryptionStore = useSessionEncryptionStore()

interface Project {
  id: string
  path: string
  sessions: number
  updated_at: string
}

interface Session {
  id: string
  title: string
  path: string
  updated_at: string
  messages: { role: 'user' | 'assistant'; text: string }[]
}

const projects = ref<Project[]>([])
const selected = ref<Project | null>(null)
const sessions = ref<Session[]>([])
const loading = ref(true)
const loadingSessions = ref(false)
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
  loading.value = true
  error.value = null
  try {
    projects.value = await call<Project[]>('io.xconn.deskconn.deskconnd.claude.project.list')
    const current = projects.value.find((p) => p.id === selected.value?.id) ?? projects.value[0]
    if (current) await selectProject(current)
  } catch (e) {
    error.value = formatDesktopError(e)
  } finally {
    loading.value = false
  }
}

async function selectProject(project: Project) {
  selected.value = project
  loadingSessions.value = true
  error.value = null
  try {
    const result = await call<Session[]>('io.xconn.deskconn.deskconnd.claude.session.list', project.id)
    if (selected.value === project) sessions.value = result
  } catch (e) {
    error.value = formatDesktopError(e)
  } finally {
    loadingSessions.value = false
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
  emit('resume-claude', path)
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

onMounted(loadProjects)
</script>

<template>
  <div class="cp-root">
  <div class="cp-container">
  <div class="claude-panel">
    <div v-if="loading" class="cp-state"><span class="spinner-border spinner-border-sm"></span> Loading…</div>
    <div v-else-if="!projects.length" class="cp-state cp-state--column">
      <span><i class="bi bi-claude"></i> {{ error ?? 'No Claude sessions on this machine yet.' }}</span>
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
          :key="p.id"
          class="cp-project"
          :class="{ 'cp-project--active': selected?.id === p.id }"
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
          <button class="cp-resume" @click="emit('resume-claude', selected.path)">
            <i class="bi bi-plus-lg"></i> New session
          </button>
        </header>
        <div v-if="error" class="cp-error"><i class="bi bi-exclamation-triangle"></i> {{ error }}</div>
        <div v-if="loadingSessions" class="cp-state"><span class="spinner-border spinner-border-sm"></span> Loading sessions…</div>
        <div v-else-if="!sessions.length && !error" class="cp-state">No sessions in this directory.</div>
        <article v-for="s in loadingSessions ? [] : sessions" :key="s.id" class="cp-session">
          <header class="cp-session-head">
            <div class="cp-session-title">
              <strong>{{ s.title || 'Untitled session' }}</strong>
              <span class="cp-project-meta">{{ ago(s.updated_at) }} · {{ s.id.slice(0, 8) }}</span>
            </div>
            <button class="cp-resume" @click="emit('resume-claude', s.path || selected!.path, s.id)">
              <i class="bi bi-play-fill"></i> Resume
            </button>
          </header>
          <div v-for="(m, i) in s.messages" :key="i" class="cp-msg" :class="`cp-msg--${m.role}`">
            <span class="cp-msg-role">{{ m.role === 'user' ? 'You' : 'Claude' }}</span>
            <p>{{ m.text }}</p>
          </div>
        </article>
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
  container-type: inline-size;
  color-scheme: dark;
  scrollbar-color: #3a3a3a #000000;
}

.claude-panel {
  display: flex;
  height: 100%;
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
  background: rgba(217, 119, 87, 0.22);
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
  background: #d97757;
  color: #fff;
  border: 0;
  border-radius: 6px;
  padding: 0.25rem 0.65rem;
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.cp-resume:hover {
  background: #c4643f;
}

.cp-msg {
  border-left: 2px solid #3a3a3a;
  padding: 0.1rem 0 0.1rem 0.5rem;
  margin-top: 0.3rem;
}

.cp-msg--user {
  border-left-color: #d97757;
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
  .claude-panel {
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
