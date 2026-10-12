<script setup lang="ts">
import { ref, shallowRef, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { type Session } from 'xconn'

import { useSessionCacheStore } from '@/stores/sessionCache'
import { useSessionEncryptionStore } from '@/stores/sessionEncryption'
import { useSettingsStore } from '@/stores/settings'
import { useEntryNavigation } from '@/composables/useEntryNavigation'
import {
  encryptPayload,
  decryptPayload,
  type EncryptionKeys,
} from '@/utils/encryption'
import {
  DESKTOP_OFFLINE_MESSAGE,
  formatDesktopError,
  isDesktopOfflineError,
  isNoSuchProcedureException,
} from '@/utils/desktopError'

const procedureIndexQuery  = 'io.xconn.deskconn.deskconnd.index.query'

interface IndexEntry {
  path:      string
  name:      string
  category:  string
  size:      number
  mod_time:  string
  thumbnail?: string
}

interface IndexQueryResult {
  status:       'indexing' | 'ready'
  entries?:     IndexEntry[]
  next_cursor?: Record<string, string>
  has_more?:    boolean
}

const PAGE_SIZE = 100

type DocFilter = 'all' | 'pdf' | 'text' | 'json' | 'office'

const props = defineProps<{
  realm: string
  category: string
  desktopName?: string
  focused?: boolean
  /** The host's scroll area (Files app): when set, the list grows in place and
   * scrolls with it, so there's one scrollbar instead of a nested one. */
  scrollContainer?: HTMLElement | null
}>()

const emit = defineEmits<{
  'open-files': [path: string]
  'preview-file': [session: Session, entry: IndexEntry, entries: IndexEntry[]]
}>()

const sessionCacheStore = useSessionCacheStore()
const sessionEncryptionStore = useSessionEncryptionStore()
const settingsStore = useSettingsStore()

const isConnecting  = ref(true)
const isLoading     = ref(false)
const isLoadingMore = ref(false)
const error         = ref('')
const indexStatus   = ref<'indexing' | 'ready' | null>(null)
const entries       = ref<IndexEntry[]>([])
const docFilter     = ref<DocFilter>('all')
const selectedEntry = ref<IndexEntry | null>(null)
const hoveredEntry = ref<IndexEntry | null>(null)
const entryListRef  = ref<HTMLElement | null>(null)
const isGridView    = ref(window.innerWidth >= 768)

const nextCursor = ref<Record<string, string> | undefined>(undefined)
const hasMore    = ref(false)
const activeSession = shallowRef<Session | null>(null)
let activeKeys: EncryptionKeys | null = null
let activeCategories: string[] = []

const previewSession = shallowRef<Session | null>(null)

const contextMenu = ref<{ x: number; y: number; entry: IndexEntry } | null>(null)

function openContextMenu(e: MouseEvent, entry: IndexEntry) {
  e.preventDefault()
  contextMenu.value = { x: e.clientX, y: e.clientY, entry }
}

function closeContextMenu() {
  contextMenu.value = null
}

function viewInFiles(entry: IndexEntry) {
  emit('open-files', entry.path)
}

function handleContextMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeContextMenu()
}

function updateViewMode() { isGridView.value = window.innerWidth >= 768 }

const viewConfig = computed(() => {
  switch (props.category) {
    case 'pictures':
      return { title: 'Pictures', icon: 'bi-images', color: '#ec4899', bg: '#fce7f3', backendCategory: 'images' as string | null }
    case 'videos':
      return { title: 'Videos', icon: 'bi-collection-play-fill', color: '#7c3aed', bg: '#ede9fe', backendCategory: 'videos' as string | null }
    default:
      return { title: 'Documents', icon: 'bi-file-earmark-richtext-fill', color: '#d97706', bg: '#fef3c7', backendCategory: null }
  }
})

// Entries arrive pre-sorted (newest first) from the backend, including
// across pages, so no client-side sort is needed.
const docFilterCounts = computed(() => {
  const all = entries.value
  return {
    all:    all.length,
    pdf:    all.filter(e => e.category === 'pdfs').length,
    json:   all.filter(e => e.name.toLowerCase().endsWith('.json')).length,
    text:   all.filter(e => e.category === 'texts' && !e.name.toLowerCase().endsWith('.json')).length,
    office: all.filter(e => e.category === 'documents').length,
  }
})

const filteredDocEntries = computed(() => {
  const all = entries.value
  switch (docFilter.value) {
    case 'pdf':    return all.filter(e => e.category === 'pdfs')
    case 'json':   return all.filter(e => e.name.toLowerCase().endsWith('.json'))
    case 'text':   return all.filter(e => e.category === 'texts' && !e.name.toLowerCase().endsWith('.json'))
    case 'office': return all.filter(e => e.category === 'documents')
    default:       return all
  }
})

const displayEntries = computed(() =>
  props.category === 'documents' ? filteredDocEntries.value : entries.value
)

function openEntry(entry: IndexEntry) {
  if (!previewSession.value) return
  emit('preview-file', previewSession.value, entry, displayEntries.value)
}

const { handleNavKey } = useEntryNavigation({
  entries: () => displayEntries.value,
  getKey: (e) => e.path,
  selected: selectedEntry,
  listRef: entryListRef,
  isGrid: () => isGridView.value,
  onOpen: openEntry,
})

function handleKeydown(e: KeyboardEvent) {
  if (!props.focused) return
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
  // Otherwise a stale hover (mouse hasn't moved since) keeps highlighting the
  // old entry, and scrollActive() can target it instead of the real selection.
  hoveredEntry.value = null
  handleNavKey(e)
}

function entryIconClass(entry: IndexEntry): string {
  if (entry.category === 'images') return 'bi-image-fill'
  if (entry.category === 'videos') return 'bi-file-earmark-play-fill'
  if (entry.category === 'pdfs')   return 'bi-file-earmark-pdf-fill'
  const ext = entry.name.toLowerCase().split('.').pop() || ''
  if (ext === 'json')                                        return 'bi-filetype-json'
  if (/^(yaml|yml|toml|xml|ini|cfg|env)$/.test(ext))       return 'bi-filetype-yml'
  if (/^(html|htm)$/.test(ext))                             return 'bi-filetype-html'
  if (ext === 'md')                                          return 'bi-file-earmark-text-fill'
  if (/^(doc|docx|odt|rtf|pages)$/.test(ext))              return 'bi-file-earmark-word-fill'
  if (/^(xls|xlsx|ods|numbers|csv)$/.test(ext))            return 'bi-file-earmark-spreadsheet-fill'
  if (/^(ppt|pptx|odp|key)$/.test(ext))                    return 'bi-file-earmark-slides-fill'
  if (ext === 'epub')                                        return 'bi-book-fill'
  return 'bi-file-earmark-text-fill'
}

function entryIconStyle(entry: IndexEntry): { color: string; background: string } {
  if (entry.category === 'images') return { color: '#ec4899', background: '#fce7f3' }
  if (entry.category === 'videos') return { color: '#7c3aed', background: '#ede9fe' }
  if (entry.category === 'pdfs')   return { color: '#ef4444', background: '#fee2e2' }
  const ext = entry.name.toLowerCase().split('.').pop() || ''
  if (ext === 'json')                                       return { color: '#10b981', background: '#d1fae5' }
  if (/^(yaml|yml|toml)$/.test(ext))                      return { color: '#34d399', background: '#ecfdf5' }
  if (/^(html|htm)$/.test(ext))                            return { color: '#f97316', background: '#ffedd5' }
  if (/^(doc|docx|odt|rtf|pages)$/.test(ext))            return { color: '#2563eb', background: '#dbeafe' }
  if (/^(xls|xlsx|ods|numbers|csv)$/.test(ext))          return { color: '#16a34a', background: '#dcfce7' }
  if (/^(ppt|pptx|odp|key)$/.test(ext))                  return { color: '#ea580c', background: '#ffedd5' }
  if (ext === 'epub')                                      return { color: '#7c3aed', background: '#ede9fe' }
  return { color: '#64748b', background: '#f1f5f9' }
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB']
  let v = size, i = -1
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

function formatDate(value: string): string {
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d)
}

async function queryIndex(
  sess: Session,
  keys: EncryptionKeys,
  categories: string[],
  cursor?: Record<string, string>,
): Promise<IndexQueryResult> {
  const payload      = { categories, cursor, limit: PAGE_SIZE }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  const encrypted    = encryptPayload(payloadBytes, keys.encryptKey)
  const result       = await sess.call(procedureIndexQuery, [encrypted])
  const enc          = result.args?.[0] as Uint8Array
  if (!enc?.length) throw new Error('Empty response from index service')
  const decrypted    = decryptPayload(enc, keys.decryptKey)
  return JSON.parse(new TextDecoder().decode(decrypted)) as IndexQueryResult
}

// Older backends ignore `categories`/`cursor`/`limit` and return every
// indexed entry across all categories in one shot. Filter client-side so
// such responses still only show what this view asked for, and treat the
// absence of has_more (older backends omit it) as "everything is here".
function filterToCategories(list: IndexEntry[], categories: string[]): IndexEntry[] {
  return list.filter((e) => categories.includes(e.category))
}

function reportError(err: unknown, fallback: string) {
  if (isDesktopOfflineError(err)) sessionCacheStore.reportUnreachable(props.realm)
  // The index query is only registered while media-app is running.
  error.value = isNoSuchProcedureException(err) ? 'media-app is offline.' : formatDesktopError(err, fallback)
}

async function loadMore() {
  if (!hasMore.value || isLoadingMore.value) return
  if (!activeSession.value || !activeKeys) return

  isLoadingMore.value = true
  try {
    const result = await queryIndex(activeSession.value, activeKeys, activeCategories, nextCursor.value)
    const page = filterToCategories(result.entries ?? [], activeCategories)
    entries.value = [...entries.value, ...page]
    nextCursor.value = result.next_cursor
    hasMore.value = result.has_more ?? false
  } catch (err) {
    reportError(err, 'Failed to load more files')
  } finally {
    isLoadingMore.value = false
  }

  // Keep filling the viewport if the loaded page didn't produce a scrollbar.
  await nextTick()
  maybeLoadMore()
}

function scrollEl() {
  return props.scrollContainer ?? entryListRef.value
}

watch(() => props.scrollContainer, (el, _, onCleanup) => {
  el?.addEventListener('scroll', handleScroll, { passive: true })
  onCleanup(() => el?.removeEventListener('scroll', handleScroll))
}, { immediate: true })

function maybeLoadMore() {
  const el = scrollEl()
  if (!el || !hasMore.value || isLoadingMore.value) return
  if (el.scrollHeight <= el.clientHeight + 200) {
    void loadMore()
  }
}

function handleScroll() {
  const el = scrollEl()
  if (!el) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
    void loadMore()
  }
}

async function load() {
  isConnecting.value  = true
  isLoading.value     = false
  error.value         = ''
  indexStatus.value   = null
  entries.value       = []
  selectedEntry.value = null
  nextCursor.value    = undefined
  hasMore.value       = false
  activeSession.value = null
  activeKeys          = null

  let sess: Session | null = null
  try {
    sess = await sessionCacheStore.acquire(props.realm)
  } catch (err) {
    reportError(err, 'Could not connect to desktop')
    isConnecting.value = false
    return
  }

  if (!sess) {
    error.value = DESKTOP_OFFLINE_MESSAGE
    isConnecting.value = false
    return
  }

  previewSession.value = sess

  isConnecting.value = false
  isLoading.value    = true

  try {
    // Shared across every window on this realm's session (see
    // sessionEncryption.ts) — the backend keeps only one key per session, so
    // Files/Pictures/an Image Viewer save all have to reuse the same one.
    const keys = await sessionEncryptionStore.getOrExchange(sess, props.realm)

    const backendCat = viewConfig.value.backendCategory
    const categories = backendCat !== null ? [backendCat] : ['pdfs', 'texts', 'documents']

    const result = await queryIndex(sess, keys, categories)
    indexStatus.value = result.status
    if (result.status === 'ready') {
      entries.value     = filterToCategories(result.entries ?? [], categories)
      nextCursor.value  = result.next_cursor
      hasMore.value     = result.has_more ?? false
      activeSession.value = sess
      activeKeys          = keys
      activeCategories    = categories
    }
  } catch (err) {
    reportError(err, 'Failed to load index')
  } finally {
    isLoading.value = false
  }

  await nextTick()
  maybeLoadMore()
}

onMounted(() => {
  window.addEventListener('resize', updateViewMode)
  document.addEventListener('keydown', handleKeydown)
  load()
})

onUnmounted(() => {
  window.removeEventListener('resize', updateViewMode)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="indexed-view fade-in-up" @click="closeContextMenu" @keydown="handleContextMenuKeydown">
    <Teleport to="body">
      <div
        v-if="contextMenu"
        class="ctx-menu"
        :style="{ top: contextMenu.y + 'px', left: contextMenu.x + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="viewInFiles(contextMenu.entry); closeContextMenu()">
          <i class="bi bi-folder2-open"></i>
          View in Files
        </button>
      </div>
    </Teleport>

    <div v-if="isConnecting || isLoading" class="state-center">
      <div class="pulse-ring" :style="{ background: viewConfig.bg }">
        <i class="bi" :class="viewConfig.icon" :style="{ color: viewConfig.color }"></i>
      </div>
      <p class="state-label">{{ isConnecting ? 'Connecting…' : 'Loading index…' }}</p>
    </div>

    <div v-else-if="error" class="state-center">
      <div class="state-icon error-icon"><i class="bi bi-exclamation-circle-fill"></i></div>
      <p class="state-label">{{ error }}</p>
      <button class="action-btn" @click="load">Try again</button>
    </div>

    <div v-else-if="indexStatus === 'indexing'" class="state-center">
      <div class="state-icon indexing-icon"><i class="bi bi-hourglass-split"></i></div>
      <p class="state-label">Still indexing your files…</p>
      <p class="state-sub">The desktop is still scanning. Check back in a moment.</p>
      <button class="action-btn" @click="load">Refresh</button>
    </div>

    <div v-else-if="indexStatus === 'ready'" class="content-area">

      <div v-if="category === 'documents'" class="chip-bar">
        <button
          v-for="chip in (['all', 'pdf', 'text', 'json', 'office'] as DocFilter[])"
          :key="chip"
          class="chip"
          :class="{ 'chip-active': docFilter === chip }"
          @click="docFilter = chip; selectedEntry = null"
        >
          {{ chip === 'all' ? 'All' : chip === 'pdf' ? 'PDF' : chip === 'text' ? 'Text' : chip === 'json' ? 'JSON' : 'Office' }}
          <span class="chip-count">{{ docFilterCounts[chip] }}</span>
        </button>
      </div>

      <div v-if="displayEntries.length === 0" class="state-center">
        <div class="state-icon" :style="{ background: viewConfig.bg, color: viewConfig.color }">
          <i class="bi" :class="viewConfig.icon"></i>
        </div>
        <p class="state-label">No files found.</p>
      </div>

      <div
        v-else
        ref="entryListRef"
        class="entry-list"
        :class="{ 'grid-view': isGridView, 'entry-list--flow': !!scrollContainer }"
        @scroll="handleScroll"
        @click.self="selectedEntry = null"
      >
        <button
          v-for="entry in displayEntries"
          :key="entry.path"
          class="entry-row"
          :class="{ active: selectedEntry?.path === entry.path || hoveredEntry?.path === entry.path }"
          @click="settingsStore.singleClickOpen ? openEntry(entry) : (isGridView ? selectedEntry = entry : openEntry(entry))"
          @dblclick="openEntry(entry)"
          @mouseenter="hoveredEntry = entry"
          @mouseleave="hoveredEntry = null"
          @contextmenu.prevent.stop="openContextMenu($event, entry)"
          :title="entry.path"
        >
          <div class="entry-main">
            <span
              class="entry-icon"
              :class="{ 'entry-icon--thumb': !!entry.thumbnail }"
              :style="entry.thumbnail ? undefined : entryIconStyle(entry)"
            >
              <img
                v-if="entry.thumbnail"
                :src="`data:image/jpeg;base64,${entry.thumbnail}`"
                class="entry-thumb"
                :alt="entry.name"
                loading="lazy"
              />
              <i v-else class="bi" :class="entryIconClass(entry)"></i>
              <span v-if="category === 'videos'" class="video-badge">
                <i class="bi bi-play-fill"></i>
              </span>
            </span>
            <div class="entry-text">
              <div class="entry-name">{{ entry.name }}</div>
              <div class="entry-meta">{{ formatSize(entry.size) }} · {{ formatDate(entry.mod_time) }}</div>
            </div>
          </div>
          <div class="entry-side">
            <i class="bi bi-chevron-right entry-chevron"></i>
          </div>
        </button>

        <div v-if="isLoadingMore" class="load-more-indicator">
          <i class="bi bi-arrow-repeat spin"></i> Loading more…
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.indexed-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

/* ── State screens ── */
.state-center {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 0.75rem; padding: 2.5rem 1.5rem; text-align: center;
}
.pulse-ring {
  width: 56px; height: 56px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 1.5rem; animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50%       { transform: scale(1.08); opacity: 0.72; }
}
.state-icon { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.4rem; }
.error-icon    { background: #fee2e2; color: #ef4444; }
.indexing-icon { background: #fef9ec; color: #d97706; animation: pulse 2s ease-in-out infinite; }
.state-label { font-size: 0.95rem; font-weight: 600; color: #334155; margin: 0; }
.state-sub   { font-size: 0.82rem; color: #94a3b8; margin: 0; max-width: 280px; }
.action-btn {
  padding: 0.4rem 1.2rem; border-radius: 8px; border: 1.5px solid #e2e8f0;
  background: #fff; font-size: 0.82rem; font-weight: 600; color: #334155;
  cursor: pointer; font-family: inherit; transition: background 0.13s, border-color 0.13s;
}
.action-btn:hover { background: #f1f5f9; border-color: #cbd5e1; }

/* ── Content ── */
.content-area { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.chip-bar { display: flex; gap: 0.4rem; padding: 0.6rem 0.85rem 0.5rem; overflow-x: auto; scrollbar-width: none; border-bottom: 1px solid #f1f5f9; flex-shrink: 0; }
.chip-bar::-webkit-scrollbar { display: none; }
.chip { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.28rem 0.7rem; border-radius: 20px; border: 1.5px solid #e2e8f0; background: #fff; font-size: 0.74rem; font-weight: 600; color: #475569; cursor: pointer; white-space: nowrap; font-family: inherit; transition: background 0.12s, border-color 0.12s, color 0.12s; }
.chip:hover { background: #f8fafc; border-color: #cbd5e1; }
.chip-active { background: #1e293b; border-color: #1e293b; color: #fff; }
.chip-active .chip-count { background: rgba(255,255,255,0.18); color: #fff; }
.chip-count { font-size: 0.67rem; font-weight: 700; background: #f1f5f9; color: #64748b; border-radius: 10px; padding: 0 0.35rem; line-height: 1.6; }

/* ── List view ── */
.entry-list { display: flex; flex-direction: column; gap: 0.75rem; overflow-y: auto; padding: 0.75rem 1rem; flex: 1; }
.entry-list--flow { overflow-y: visible; flex: none; }
.entry-row { -webkit-touch-callout: none; display: flex; justify-content: space-between; align-items: center; gap: 1rem; width: 100%; text-align: left; border: 1px solid rgba(113,130,149,0.14); border-radius: 18px; background: #fff; padding: 0.95rem 1rem; cursor: pointer; font-family: inherit; transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease; }
.entry-row:hover, .entry-row.active { border-color: rgba(0,0,0,0.2); box-shadow: 0 10px 24px rgba(71,85,105,0.08); }
/* .active already shows selection — suppress the native focus ring, which
   differs wildly by browser (red in Firefox, black in Chrome). */
.entry-row::-moz-focus-inner { border: 0; }
.entry-row:focus { outline: none; }
.entry-main { display: flex; align-items: center; gap: 0.9rem; flex: 1; min-width: 0; }
.entry-side { display: flex; align-items: center; flex-shrink: 0; }
.entry-icon { width: 42px; height: 42px; display: inline-flex; align-items: center; justify-content: center; border-radius: 14px; font-size: 1.15rem; flex: 0 0 auto; position: relative; }
.entry-icon--thumb { background: #111 !important; padding: 0; overflow: hidden; }
.entry-thumb { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: inherit; }
.video-badge { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.35); border-radius: inherit; font-size: 0.85rem; color: rgba(255,255,255,0.9); pointer-events: none; }
.entry-text { min-width: 0; overflow: hidden; }
.entry-name { color: #21313f; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9rem; }
.entry-meta { color: #778697; font-size: 0.8rem; white-space: nowrap; }
.entry-chevron { color: #cbd5e1; font-size: 0.75rem; }

/* ── Infinite scroll ── */
.load-more-indicator {
  grid-column: 1 / -1;
  display: flex; align-items: center; justify-content: center; gap: 0.4rem;
  padding: 0.85rem; font-size: 0.8rem; font-weight: 600; color: #94a3b8;
}
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Grid view (≥ 768 px) — identical to EmbeddedDesktopFiles ── */
@media (min-width: 768px) {
  .entry-list.grid-view { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 0.2rem; flex: 1; max-height: none; align-content: start; padding: 0.35rem; }
  .entry-list.grid-view .entry-row { display: flex; flex-direction: column; align-items: center; justify-content: flex-start; padding: 0.8rem 0.4rem 0.7rem; gap: 0.5rem; border: 1.5px solid transparent; border-radius: 10px; background: transparent; text-align: center; width: 100%; min-height: unset; transition: background 0.13s ease, border-color 0.13s ease; }
  .entry-list.grid-view .entry-row:hover { background: rgba(241,245,249,0.9); border-color: rgba(0,0,0,0.07); transform: none; box-shadow: none; }
  .entry-list.grid-view .entry-row.active { background: #dbeafe; border-color: rgba(59,130,246,0.28); transform: none; box-shadow: none; }
  .entry-list.grid-view .entry-main { flex-direction: column; align-items: center; gap: 0.5rem; width: 100%; min-width: 0; }
  .entry-list.grid-view .entry-icon { width: 52px; height: 52px; font-size: 1.65rem; border-radius: 12px; flex-shrink: 0; }
  .entry-list.grid-view .entry-name { font-size: 0.69rem; font-weight: 600; text-align: center; white-space: normal; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 1.35; max-width: 100%; word-break: break-word; }
  .entry-list.grid-view .entry-meta, .entry-list.grid-view .entry-side { display: none; }
}

/* ── Context menu ── */
:global(.ctx-menu) {
  position: fixed;
  z-index: 9999;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(71, 85, 105, 0.14);
  padding: 0.3rem;
  min-width: 160px;
}
:global(.ctx-item) {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 7px;
  background: none;
  font-family: inherit;
  font-size: 0.84rem;
  font-weight: 500;
  color: #1e293b;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}
:global(.ctx-item:hover) { background: #f1f5f9; }
:global(.ctx-item .bi) { font-size: 0.95rem; color: #2563eb; }
</style>
