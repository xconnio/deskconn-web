<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef } from 'vue'
import type { Session } from '@/services/xconn'
import type { FileEntry } from '@/types'
import type { EncryptionKeys } from '@/utils/encryption'
import { createFileBrowser } from '@/utils/fileBrowse'
import { formatDesktopError } from '@/utils/desktopError'
import { useSettingsStore } from '@/stores/settings'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { detectPathSeparator, isPathWithinHome, joinPath, normalizeComparablePath, relativeSegments } from '@/utils/filePath'

const props = defineProps<{
  session: Session
  keys: EncryptionKeys
  mode: 'open-file' | 'open-folder' | 'save-as'
  initialPath?: string
  initialFileName?: string
}>()

const emit = defineEmits<{
  confirm: [path: string]
  cancel: []
}>()

const fileBrowser = shallowRef(createFileBrowser(props.session, () => props.keys))
const currentPath = ref('')
const homePath = ref('')
const parentPath = ref<string | undefined>(undefined)
const entries = ref<FileEntry[]>([])
const selectedEntry = ref<FileEntry | null>(null)
const fileName = ref(props.initialFileName ?? '')
const loading = ref(false)
const error = ref('')
const confirmReplace = ref(false)

const title = computed(() => ({
  'open-file': 'Open File',
  'open-folder': 'Open Folder',
  'save-as': 'Save As',
}[props.mode]))

const confirmLabel = computed(() => ({
  'open-file': 'Open',
  'open-folder': 'Select Folder',
  'save-as': 'Save',
}[props.mode]))

const canConfirm = computed(() => {
  if (props.mode === 'open-file') return !!selectedEntry.value && !selectedEntry.value.is_dir
  if (props.mode === 'save-as') return fileName.value.trim().length > 0
  return true
})

// The picker never lets the user browse above their home directory — the Up
// button and breadcrumbs both stop there.
const canGoUp = computed(() => {
  if (!parentPath.value || !homePath.value) return false
  return normalizeComparablePath(currentPath.value) !== normalizeComparablePath(homePath.value)
})

const breadcrumbs = computed(() => {
  const home = normalizeComparablePath(homePath.value)
  const current = normalizeComparablePath(currentPath.value)
  if (!home) return []
  if (current === home) return [{ label: 'Home', path: home }]

  const parts = relativeSegments(current, home)
  if (parts.length === 0) return [{ label: home, path: current }]

  const sep = detectPathSeparator(home)
  const segments = [{ label: 'Home', path: home }]
  let running = home
  for (const part of parts) {
    running = `${running}${sep}${part}`
    segments.push({ label: part, path: running })
  }
  return segments
})

function visibleEntries(list: FileEntry[] | undefined): FileEntry[] {
  return (list ?? []).filter((e) => !e.hidden && !e.name.startsWith('.'))
}

// Folders expanded in place via their chevron, so their contents can be seen
// without navigating in and back out. Children load on first expand.
// Not in save-as: it saves into the folder being browsed, so a file picked
// from inside an expanded subfolder would be saved in the wrong place.
const canExpand = computed(() => props.mode !== 'save-as')
const expanded = ref(new Set<string>())
const children = ref<Record<string, FileEntry[] | 'loading' | 'error'>>({})

async function toggleExpand(entry: FileEntry) {
  const next = new Set(expanded.value)
  if (next.delete(entry.path)) {
    expanded.value = next
    return
  }
  next.add(entry.path)
  expanded.value = next
  if (Array.isArray(children.value[entry.path])) return
  children.value = { ...children.value, [entry.path]: 'loading' }
  try {
    const browse = await fileBrowser.value.browseFiles(entry.path)
    children.value = { ...children.value, [entry.path]: visibleEntries(browse.entries) }
  } catch {
    children.value = { ...children.value, [entry.path]: 'error' }
  }
}

type Row =
  | { kind: 'entry'; entry: FileEntry; depth: number }
  | { kind: 'loading' | 'error' | 'empty'; key: string; depth: number }

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (list: FileEntry[], depth: number) => {
    for (const entry of list) {
      out.push({ kind: 'entry', entry, depth })
      if (!entry.is_dir || !expanded.value.has(entry.path)) continue
      const kids = children.value[entry.path]
      if (kids === 'loading' || kids === 'error') out.push({ kind: kids, key: `${entry.path}:${kids}`, depth: depth + 1 })
      else if (!kids?.length) out.push({ kind: 'empty', key: `${entry.path}:empty`, depth: depth + 1 })
      else walk(kids, depth + 1)
    }
  }
  walk(entries.value, 0)
  return out
})

async function load(path: string) {
  loading.value = true
  error.value = ''
  selectedEntry.value = null
  expanded.value = new Set()
  children.value = {}
  try {
    const browse = await fileBrowser.value.browseFiles(path)
    // A typed path can point anywhere: checked once the desktop has resolved it (.., ~).
    if (!isPathWithinHome(browse.path, browse.home_path)) {
      error.value = 'Only folders inside your home folder can be opened here.'
      return
    }
    currentPath.value = browse.path
    homePath.value = browse.home_path
    parentPath.value = browse.parent_path
    // Files are still listed in open-folder mode (for context — see
    // isDisabledEntry below) even though they can't be picked there.
    entries.value = visibleEntries(browse.entries)
  } catch (err) {
    error.value = formatDesktopError(err, 'Failed to browse remote path')
  } finally {
    loading.value = false
  }
}

function goUp() {
  if (canGoUp.value && parentPath.value) void load(parentPath.value)
}

// Double-clicking the breadcrumbs swaps them for a text field, to type or paste a path:
// absolute, or under ~ (the browse procedure takes paths relative to home).
const editingPath = ref<string | null>(null)
const pathInput = ref<HTMLInputElement | null>(null)

async function editPath() {
  editingPath.value = currentPath.value
  await nextTick()
  pathInput.value?.select()
}

function submitPath() {
  const path = editingPath.value?.trim()
  editingPath.value = null
  if (path) void load(path === '~' ? '' : path.replace(/^~\//, ''))
}

function goToBreadcrumb(path: string) {
  if (path !== currentPath.value || error.value) void load(path)
}

// In open-folder mode, files are shown for context but can't be picked —
// only directories are valid targets there.
function isDisabledEntry(entry: FileEntry): boolean {
  return props.mode === 'open-folder' && !entry.is_dir
}

// Single click only selects (matches native folder pickers) — it never
// navigates. Double click is what opens a directory.
const settingsStore = useSettingsStore()

function onEntryClick(entry: FileEntry) {
  if (isDisabledEntry(entry)) return
  // Single-click-open (the touch default): a tap enters folders; files still
  // just select so the confirm button stays the only way to pick one.
  if (entry.is_dir && settingsStore.singleClickOpen) {
    void load(entry.path)
    return
  }
  selectedEntry.value = entry
  if (props.mode === 'save-as' && !entry.is_dir) fileName.value = entry.name
}

function onEntryDblClick(entry: FileEntry) {
  if (isDisabledEntry(entry)) return
  if (entry.is_dir) {
    void load(entry.path)
    return
  }
  if (props.mode === 'open-file') emit('confirm', entry.path)
}

function confirm() {
  if (!canConfirm.value) return
  if (props.mode === 'open-file') {
    emit('confirm', selectedEntry.value!.path)
  } else if (props.mode === 'save-as') {
    const name = fileName.value.trim()
    if (!confirmReplace.value && entries.value.some((e) => !e.is_dir && e.name === name)) {
      confirmReplace.value = true
      return
    }
    confirmReplace.value = false
    emit('confirm', joinPath(currentPath.value, name))
  } else {
    // open-folder: an explicitly selected subfolder wins, otherwise confirm
    // whichever folder is currently being browsed.
    emit('confirm', selectedEntry.value?.is_dir ? selectedEntry.value.path : currentPath.value)
  }
}

onMounted(() => load(props.initialPath ?? ''))
</script>

<template>
  <div class="picker-backdrop" @click.self="emit('cancel')">
    <div class="picker-dialog">
      <div class="picker-header">
        <span>{{ title }}</span>
        <button class="picker-close" @click="emit('cancel')"><i class="bi bi-x-lg"></i></button>
      </div>

      <div class="picker-pathbar">
        <button class="picker-up" :disabled="!canGoUp || loading" @click="goUp">
          <i class="bi bi-arrow-up"></i>
        </button>
        <input
          v-if="editingPath !== null"
          ref="pathInput"
          v-model="editingPath"
          class="picker-path-input"
          spellcheck="false"
          @keydown.enter.prevent="submitPath"
          @keydown.esc.stop.prevent="editingPath = null"
          @blur="editingPath = null"
        />
        <div v-else class="picker-breadcrumbs" title="Double-click to type a path" @dblclick="editPath">
          <template v-for="(segment, index) in breadcrumbs" :key="segment.path">
            <button
              class="picker-breadcrumb"
              :class="{
                'picker-breadcrumb-home': index === 0,
                'picker-breadcrumb-current': index === breadcrumbs.length - 1,
              }"
              @click="goToBreadcrumb(segment.path)"
            >
              <i v-if="index === 0" class="bi bi-house-fill"></i>{{ segment.label }}
            </button>
            <span v-if="index < breadcrumbs.length - 1" class="picker-breadcrumb-sep">/</span>
          </template>
        </div>
      </div>

      <div class="picker-body">
        <div v-if="loading" class="picker-state">
          <span class="spinner-border spinner-border-sm" role="status"></span>
        </div>
        <div v-else-if="error" class="picker-state picker-error">{{ error }}</div>
        <div v-else-if="entries.length === 0" class="picker-state text-muted">Empty folder</div>
        <div v-else class="picker-list">
          <template v-for="row in rows" :key="row.kind === 'entry' ? row.entry.path : row.key">
            <button
              v-if="row.kind === 'entry'"
              class="picker-row"
              :class="{ active: selectedEntry?.path === row.entry.path, disabled: isDisabledEntry(row.entry) }"
              :style="{ paddingLeft: `${0.6 + row.depth * 1.1}rem` }"
              @click="onEntryClick(row.entry)"
              @dblclick="onEntryDblClick(row.entry)"
            >
              <span
                v-if="canExpand"
                class="picker-chevron"
                :class="{ 'picker-chevron-none': !row.entry.is_dir }"
                :title="expanded.has(row.entry.path) ? 'Collapse' : 'Expand'"
                @click.stop="row.entry.is_dir && toggleExpand(row.entry)"
                @dblclick.stop
              >
                <i class="bi" :class="expanded.has(row.entry.path) ? 'bi-chevron-down' : 'bi-chevron-right'"></i>
              </span>
              <i class="bi" :class="row.entry.is_dir ? 'bi-folder-fill' : 'bi-file-earmark'"></i>
              <span class="picker-name">{{ row.entry.name }}</span>
            </button>
            <div v-else class="picker-row picker-row-note" :style="{ paddingLeft: `${0.6 + row.depth * 1.1 + 1.6}rem` }">
              <span v-if="row.kind === 'loading'" class="spinner-border spinner-border-sm" role="status"></span>
              <template v-else>{{ row.kind === 'error' ? 'Failed to load' : 'Empty folder' }}</template>
            </div>
          </template>
        </div>
      </div>

      <div v-if="mode === 'save-as'" class="picker-filename">
        <input v-model="fileName" type="text" placeholder="Filename" @keyup.enter="confirm" />
      </div>

      <div class="picker-footer">
        <button class="picker-btn picker-btn-secondary" @click="emit('cancel')">Cancel</button>
        <button class="picker-btn picker-btn-primary" :disabled="!canConfirm" @click="confirm">
          {{ confirmLabel }}
        </button>
      </div>
    </div>

    <ConfirmDialog
      :open="confirmReplace"
      title="Replace file?"
      :message="`&quot;${fileName.trim()}&quot; already exists. Saving will replace it.`"
      confirm-label="Replace"
      @confirm="confirm"
      @cancel="confirmReplace = false"
    />
  </div>
</template>

<style scoped>
.picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.55);
}

.picker-dialog {
  display: flex;
  flex-direction: column;
  width: 520px;
  max-width: 92vw;
  height: 480px;
  max-height: 82vh;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  font-weight: 700;
  font-size: 0.95rem;
  color: #1e293b;
  border-bottom: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.picker-close {
  border: 0;
  background: transparent;
  color: #64748b;
  cursor: pointer;
}

.picker-pathbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #f1f5f9;
  flex-shrink: 0;
}
.picker-up {
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  border-radius: 6px;
  width: 26px;
  height: 26px;
  color: #475569;
  flex-shrink: 0;
}
.picker-up:disabled { opacity: 0.4; }

.picker-breadcrumbs {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.picker-breadcrumbs::-webkit-scrollbar { display: none; }

.picker-path-input {
  flex: 1;
  min-width: 0;
  border: 1px solid #94a3b8;
  border-radius: 6px;
  padding: 0.2rem 0.45rem;
  font-size: 0.82rem;
  outline: none;
}

.picker-breadcrumb {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex-shrink: 0;
  border: 0;
  background: transparent;
  border-radius: 6px;
  padding: 0.2rem 0.45rem;
  font-size: 0.78rem;
  color: #475569;
  cursor: pointer;
  white-space: nowrap;
}
.picker-breadcrumb:hover { background: #f1f5f9; }
.picker-breadcrumb-home {
  font-weight: 700;
  color: #1e293b;
  background: #eef2f6;
}
.picker-breadcrumb-home:hover { background: #e2e8f0; }

/* The folder/file currently being browsed — always the last breadcrumb.
   Placed after -home so it wins when both apply (browsing at the home root). */
.picker-breadcrumb-current {
  font-weight: 700;
  color: #1e293b;
  background: #dbeafe;
  cursor: default;
}
.picker-breadcrumb-current:hover { background: #dbeafe; }

.picker-breadcrumb-sep {
  color: #cbd5e1;
  flex-shrink: 0;
}

.picker-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.picker-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 2rem;
  color: #64748b;
  font-size: 0.85rem;
}
.picker-error { color: #dc2626; }

.picker-list {
  display: flex;
  flex-direction: column;
  padding: 0.4rem;
}
.picker-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  border: 0;
  background: transparent;
  border-radius: 6px;
  text-align: left;
  font-size: 0.83rem;
  color: #334155;
  cursor: pointer;
}
.picker-row:hover { background: #f1f5f9; }
.picker-row.active { background: #dbeafe; }
.picker-row i { color: #94a3b8; flex-shrink: 0; }
.picker-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.picker-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.1rem;
  height: 1.1rem;
  border-radius: 4px;
  flex-shrink: 0;
}
.picker-chevron:hover { background: #e2e8f0; }
.picker-row .picker-chevron i { color: #64748b; font-size: 0.7rem; }
/* Files keep the chevron's width so names line up with their sibling folders. */
.picker-chevron-none { visibility: hidden; }

.picker-row-note {
  color: #94a3b8;
  font-size: 0.78rem;
  cursor: default;
}
.picker-row-note:hover { background: transparent; }

/* Files shown for context in open-folder mode — visible, but not a valid pick. */
.picker-row.disabled {
  color: #cbd5e1;
  cursor: default;
}
.picker-row.disabled i { color: #e2e8f0; }
.picker-row.disabled:hover { background: transparent; }

.picker-filename {
  padding: 0.6rem 1rem;
  border-top: 1px solid #f1f5f9;
  flex-shrink: 0;
}
.picker-filename input {
  width: 100%;
  padding: 0.4rem 0.6rem;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  font-size: 0.85rem;
}

.picker-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.65rem 1rem;
  border-top: 1px solid #e2e8f0;
  flex-shrink: 0;
}
.picker-btn {
  padding: 0.4rem 0.9rem;
  border-radius: 6px;
  font-size: 0.83rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
}
.picker-btn-secondary {
  background: #f1f5f9;
  color: #334155;
  border-color: #e2e8f0;
}
.picker-btn-primary {
  background: #2563eb;
  color: #fff;
}
.picker-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
