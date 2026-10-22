<script setup lang="ts">
import { computed, nextTick, onUnmounted, provide, reactive, ref, shallowRef, watch } from 'vue'
import type { Session } from 'xconn'
import type { FileEntry } from '@/types'
import type { EncryptionKeys } from '@/utils/encryption'
import { createFileBrowser } from '@/utils/fileBrowse'
import { fetchGitStatus, type GitFileStatus } from '@/utils/git'
import { onFileChanged } from '@/utils/fileChanges'
import { dirName, isPathWithinHome, normalizeComparablePath } from '@/utils/filePath'
import { editorFileTreeActionsKey } from '@/composables/editorFileTreeActions'
import EditorFileTreeNode from '@/components/EditorFileTreeNode.vue'

const props = defineProps<{
  session: Session
  realm: string
  rootPath: string
  rootName: string
  keys: EncryptionKeys
}>()

const emit = defineEmits<{
  'open-file': [entry: FileEntry]
  'open-file-pinned': [entry: FileEntry]
}>()

const fileBrowser = shallowRef(createFileBrowser(props.session, () => props.keys))
const rootEntries = ref<FileEntry[]>([])
const rootError = ref('')
const rootLoading = ref(false)

const expanded = reactive(new Set<string>())
const childrenByPath = reactive(new Map<string, FileEntry[]>())
const loadingPaths = reactive(new Set<string>())
const statusByPath = ref(new Map<string, GitFileStatus>())

async function loadStatus() {
  try {
    const result = await fetchGitStatus(props.session, props.keys, props.rootPath)
    const map = new Map<string, GitFileStatus>()
    for (const entry of result.entries ?? []) map.set(entry.path, entry.status)
    statusByPath.value = map
  } catch {
    // Non-repo dirs, or a git-less remote — just render without red/neutral coloring.
    statusByPath.value = new Map()
  }
}

async function loadRoot() {
  rootLoading.value = true
  rootError.value = ''
  expanded.clear()
  childrenByPath.clear()
  try {
    const browse = await fileBrowser.value.browseFiles(props.rootPath)
    rootEntries.value = browse.entries ?? []
  } catch (err) {
    rootError.value = err instanceof Error ? err.message : 'Failed to open folder'
  } finally {
    rootLoading.value = false
  }
  void loadStatus()
}

watch(() => props.rootPath, loadRoot, { immediate: true })

async function toggleDir(path: string) {
  if (expanded.has(path)) {
    expanded.delete(path)
    return
  }
  expanded.add(path)
  if (childrenByPath.has(path)) return

  loadingPaths.add(path)
  try {
    const browse = await fileBrowser.value.browseFiles(path)
    childrenByPath.set(path, browse.entries ?? [])
  } catch {
    childrenByPath.set(path, [])
  } finally {
    loadingPaths.delete(path)
  }
}

// Saves, uploads, renames and deletes made from this site (see fileChanges)
// re-list the affected folder, if it's showing, and recolor git status.
// ponytail: changes made on the device itself aren't seen until Refresh;
// needs a backend file-watch topic to subscribe to.
async function refreshDir(dir: string) {
  const isRoot = normalizeComparablePath(dir) === normalizeComparablePath(props.rootPath)
  if (!isRoot && !childrenByPath.has(dir)) return
  try {
    const entries = (await fileBrowser.value.browseFiles(dir)).entries ?? []
    if (isRoot) rootEntries.value = entries
    else childrenByPath.set(dir, entries)
  } catch {
    // Keep the current listing; Refresh is still there.
  }
}

let statusTimer: ReturnType<typeof setTimeout> | undefined
const stopFileChanges = onFileChanged((realm, path) => {
  if (realm !== props.realm || !isPathWithinHome(path, props.rootPath)) return
  // A renamed/deleted folder's cached listing is stale; drop it so it re-lists when next expanded.
  childrenByPath.delete(path)
  expanded.delete(path)
  if (normalizeComparablePath(path) !== normalizeComparablePath(props.rootPath)) void refreshDir(dirName(path))
  // One git status call for a burst of changes (e.g. a rename's two paths).
  clearTimeout(statusTimer)
  statusTimer = setTimeout(() => void loadStatus(), 150)
})
onUnmounted(() => {
  stopFileChanges()
  clearTimeout(statusTimer)
})

// ── Keyboard navigation ─────────────────────────────────────────────────────
const treeEl = ref<HTMLElement | null>(null)
const selectedPath = ref<string | null>(null)

// Every row currently on screen, top to bottom, with its parent dir — what
// the arrow keys walk.
const visibleRows = computed(() => {
  const rows: { entry: FileEntry; parent: string | null }[] = []
  const walk = (entries: FileEntry[], parent: string | null) => {
    for (const entry of entries) {
      rows.push({ entry, parent })
      if (entry.is_dir && expanded.has(entry.path)) walk(childrenByPath.get(entry.path) ?? [], entry.path)
    }
  }
  walk(rootEntries.value, null)
  return rows
})

async function select(path: string) {
  selectedPath.value = path
  await nextTick()
  const tree = treeEl.value
  const row = tree?.querySelector(`[data-path="${CSS.escape(path)}"]`)
  if (!tree || !row) return
  // Scrolls only the tree itself. scrollIntoView would also nudge every
  // ancestor (window body, editor panes), which shows up as a jerk.
  const r = row.getBoundingClientRect()
  const t = tree.getBoundingClientRect()
  if (r.top < t.top) tree.scrollTop -= t.top - r.top
  else if (r.bottom > t.bottom) tree.scrollTop += r.bottom - t.bottom
}

// Up/Down move, Home/End jump, Right expands (or steps into an expanded dir),
// Left collapses (or steps out to the parent), Enter toggles a dir / opens a file.
function onKeydown(e: KeyboardEvent) {
  // Keys aimed at the Refresh button inside the tree stay with it.
  if (e.target !== treeEl.value) return
  const rows = visibleRows.value
  if (!rows.length) return
  const i = rows.findIndex((r) => r.entry.path === selectedPath.value)
  const row = rows[i]

  switch (e.key) {
    case 'ArrowDown':
      void select(rows[Math.min(i + 1, rows.length - 1)]!.entry.path)
      break
    case 'ArrowUp':
      void select(rows[Math.max(i - 1, 0)]!.entry.path)
      break
    case 'Home':
      void select(rows[0]!.entry.path)
      break
    case 'End':
      void select(rows[rows.length - 1]!.entry.path)
      break
    case 'ArrowRight':
      if (!row?.entry.is_dir) break
      if (!expanded.has(row.entry.path)) void toggleDir(row.entry.path)
      else if (rows[i + 1]?.parent === row.entry.path) void select(rows[i + 1]!.entry.path)
      break
    case 'ArrowLeft':
      if (!row) break
      if (row.entry.is_dir && expanded.has(row.entry.path)) void toggleDir(row.entry.path)
      else if (row.parent) void select(row.parent)
      break
    case 'Enter':
      if (!row) break
      if (row.entry.is_dir) void toggleDir(row.entry.path)
      else emit('open-file-pinned', row.entry)
      break
    default:
      return
  }
  e.preventDefault()
}

provide(editorFileTreeActionsKey, {
  isExpanded: (path) => expanded.has(path),
  childrenOf: (path) => childrenByPath.get(path),
  isLoading: (path) => loadingPaths.has(path),
  statusOf: (path) => statusByPath.value.get(path),
  toggleDir,
  openFile: (entry) => emit('open-file', entry),
  openFilePinned: (entry) => emit('open-file-pinned', entry),
  isSelected: (path) => selectedPath.value === path,
  select: (path) => void select(path),
})

const rootStatus = computed(() => statusByPath.value.get(props.rootPath))
</script>

<template>
  <div ref="treeEl" class="file-tree" tabindex="0" @keydown="onKeydown">
    <div
      class="tree-root-label"
      :class="{
        'tree-row-untracked': rootStatus === 'untracked' || rootStatus === 'added',
        'tree-row-modified': rootStatus === 'modified',
        'tree-row-ignored': rootStatus === 'ignored',
      }"
    >
      <i class="bi bi-folder2-open tree-icon"></i>
      <span class="tree-name">{{ rootName }}</span>
      <button class="tree-refresh-btn" title="Refresh" @click="loadRoot">
        <i class="bi bi-arrow-clockwise"></i>
      </button>
    </div>

    <div v-if="rootLoading" class="tree-state">
      <span class="spinner-border spinner-border-sm" role="status"></span>
    </div>
    <div v-else-if="rootError" class="tree-state tree-error">{{ rootError }}</div>
    <div v-else class="tree-list">
      <EditorFileTreeNode
        v-for="entry in rootEntries"
        :key="entry.path"
        :entry="entry"
        :depth="0"
      />
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  background: #21211d;
}

.file-tree:focus {
  outline: none;
}
/* Brighter while the tree has focus, so it's clear the arrow keys act here. */
.file-tree:focus :deep(.tree-row-selected) {
  background: rgba(117, 163, 209, 0.22);
  box-shadow: inset 1px 0 0 #75a3d1;
}

.tree-root-label {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.6rem 0.6rem 0.4rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: #a6a6a1;
  flex-shrink: 0;
}
.tree-root-label .tree-icon {
  color: #75a3d1;
  font-size: 0.85rem;
}
.tree-row-untracked {
  color: #f87171 !important;
}
.tree-row-untracked .tree-icon {
  color: #f87171 !important;
}
.tree-row-modified {
  color: #7fb4e0 !important;
}
.tree-row-modified .tree-icon {
  color: #7fb4e0 !important;
}
.tree-row-ignored {
  color: #f59e0b !important;
}
.tree-row-ignored .tree-icon {
  color: #f59e0b !important;
}

.tree-refresh-btn {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: #8a8a85;
  font-size: 0.78rem;
  padding: 0.15rem;
  cursor: pointer;
  flex-shrink: 0;
}
.tree-refresh-btn:hover {
  color: #e2e2df;
}

.tree-list {
  flex: 1;
  min-height: 0;
  padding-bottom: 0.5rem;
}

.tree-state {
  display: flex;
  justify-content: center;
  padding: 1rem 0;
  color: #8a8a85;
}
.tree-error {
  font-size: 0.75rem;
  padding: 0 0.75rem;
  color: #f87171;
  text-align: center;
}
</style>
