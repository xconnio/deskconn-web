<script setup lang="ts">
import { ref, computed, onMounted, type ComponentPublicInstance } from 'vue'
import { useMachinesStore } from '@/stores/machines'
import { useDesktopSessionsStore } from '@/stores/desktopSessions'
import { useMachinesOverviewStore } from '@/stores/machinesOverview'
import { openLauncher } from '@/router/navigation'
import { machinesOverviewReturnRealm } from '@/router/index'
import { loadCachedWallpaper } from '@/composables/useWallpaperCache'
import OverviewGrid from '@/components/OverviewGrid.vue'

interface DesktopCard { id: string; realm: string; name: string; icon: string }

const machinesStore = useMachinesStore()
const desktopSessionsStore = useDesktopSessionsStore()
const machinesOverviewStore = useMachinesOverviewStore()

// A realm can have a live DesktopSessionHost mounted (e.g. it's the one
// currently open) before machinesStore has finished loading the machine
// list, or after it's since dropped out of that list — every live realm
// still gets a card, falling back to the raw realm as the name.
//
// `id` here is always the realm, not the backend Desktop.id (a separate,
// unrelated value) — OverviewGrid's selection/highlight keys off `id`, and
// every navigation in this file (machinesOverviewReturnRealm, selectMachine)
// keys off realm, so the two must be the same value or the active card never matches.
const displayDesktops = computed<DesktopCard[]>(() => {
  const known = machinesStore.desktops
  const extra = desktopSessionsStore.knownRealms
    .filter((realm) => !known.some((d) => d.realm === realm))
    .map((realm) => ({ id: realm, realm, name: realm, icon: '🖥️' }))
  return [...known.map((d) => ({ ...d, id: d.realm })), ...extra]
})

// A card's image is just that machine's cached wallpaper — a per-window
// screenshot was tried and dropped: it wasn't reliably accurate (stale or
// blank captures), so this favors "always correct, sometimes generic" over
// "sometimes wrong."
const cardImages = ref<Record<string, string | null>>({})

function setCardImage(realm: string, url: string | null) {
  const prev = cardImages.value[realm]
  if (prev && prev !== url) URL.revokeObjectURL(prev)
  cardImages.value[realm] = url
}

async function loadCardImages() {
  for (const desktop of displayDesktops.value) {
    const wallpaper = await loadCachedWallpaper(desktop.realm)
    setCardImage(desktop.realm, wallpaper?.url ?? null)
  }
}

onMounted(loadCardImages)

// Registers this card's slot for DesktopSessionHost to teleport its live desktop into.
function setPreviewTarget(realm: string, el: Element | null) {
  if (el) machinesOverviewStore.registerPreviewTarget(realm, el as HTMLElement)
  else machinesOverviewStore.unregisterPreviewTarget(realm)
}

// Cached per realm — Vue calls a template ref function on every render of
// the owner regardless of the callback's identity, so this doesn't avoid
// that; it just avoids allocating a new function each render.
type TemplateRefCallback = (el: Element | ComponentPublicInstance | null) => void
const previewRefCallbacks = new Map<string, TemplateRefCallback>()
function previewRef(realm: string): TemplateRefCallback {
  let fn = previewRefCallbacks.get(realm)
  if (!fn) {
    fn = (el) => setPreviewTarget(realm, el as Element | null)
    previewRefCallbacks.set(realm, fn)
  }
  return fn
}

function selectMachine(desktop: DesktopCard) {
  openLauncher(desktop.realm)
}

// Only shown when this overview was reached from a desktop (e.g. the dock's
// Machines button) — nothing to close back to when it's the initial landing page.
function closeOverview() {
  if (machinesOverviewReturnRealm.value) openLauncher(machinesOverviewReturnRealm.value)
}
</script>

<template>
  <div v-if="!machinesStore.hasLoadedDesktops" class="machines-loading">
    <div class="spinner-border" role="status">
      <span class="visually-hidden">Loading...</span>
    </div>
  </div>

  <OverviewGrid
    v-else
    title="Machines"
    :entries="displayDesktops"
    :active-id="machinesOverviewReturnRealm"
    :show-back="!!machinesOverviewReturnRealm"
    empty-message="No machines found"
    @select="selectMachine"
    @back="closeOverview"
  >
    <template #preview="{ entry }">
      <img v-if="cardImages[entry.realm]" :src="cardImages[entry.realm]!" alt="" class="machines-card-image" />
      <div v-else class="machines-card-placeholder">
        <i class="bi bi-pc-display"></i>
      </div>

      <div class="preview-live" :ref="previewRef(entry.realm)"></div>

      <!-- Blocks clicks/drags into the live-teleported desktop so the card still just selects the machine. -->
      <div class="preview-shield"></div>
    </template>

    <template #label="{ entry }">
      <div class="overview-label">
        <span aria-hidden="true">{{ entry.icon }}</span>
        {{ entry.name }}
      </div>
    </template>
  </OverviewGrid>
</template>

<style scoped>
.machines-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0f172a;
}

.machines-loading .spinner-border {
  color: rgba(255, 255, 255, 0.85);
}

.machines-card-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  pointer-events: none;
}

.machines-card-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.35);
  font-size: 2rem;
}

.preview-live {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.preview-shield {
  position: absolute;
  inset: 0;
}
</style>
