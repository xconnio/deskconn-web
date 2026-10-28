<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDesktopSessionsStore } from '@/stores/desktopSessions'
import { useWindowsOverviewStore } from '@/stores/windowsOverview'
import OverviewGrid from '@/components/OverviewGrid.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const route = useRoute()
const router = useRouter()
const desktopSessionsStore = useDesktopSessionsStore()
const windowsOverviewStore = useWindowsOverviewStore()

const realm = computed(() => String(route.params.realm || ''))
const manager = computed(() => desktopSessionsStore.getOrCreate(realm.value))

interface WindowEntry {
  id: string
  title: string
  icon: string
  iconColor: string
  iconBg: string
  minimized: boolean
}

const entries = computed<WindowEntry[]>(() =>
  manager.value.windows.value.map((w) => ({
    id: w.id,
    title: w.title,
    icon: w.icon,
    iconColor: w.iconColor,
    iconBg: w.iconBg,
    minimized: w.minimized,
  })),
)

function goBack() {
  router.push({ name: 'desktop-launcher', params: { realm: realm.value } })
}

// Switch to it, never toggle-minimize it just because it was already focused
// — unlike a dock icon click, selecting a card here always means "show me this one".
function onSelect(entry: WindowEntry) {
  const win = manager.value.windows.value.find((w) => w.id === entry.id)
  if (win) {
    if (win.minimized) manager.value.restoreWindow(entry.id)
    else if (manager.value.focusedId.value !== entry.id) manager.value.focusWindow(entry.id)
  }
  goBack()
}

// Mobile: back to the home screen with every app still running.
function goHome() {
  for (const w of manager.value.windows.value) if (!w.minimized) manager.value.minimizeWindow(w.id)
  goBack()
}

// An app that needs to confirm closing (busy terminal, unsaved edits) would
// show its dialog inside the window, which is only a tiny preview here — so
// it asks through this page's own dialog instead.
const pendingConfirm = ref<{ title: string; message: string; resolve: (ok: boolean) => void } | null>(null)

function answerConfirm(ok: boolean) {
  pendingConfirm.value?.resolve(ok)
  pendingConfirm.value = null
}

function onClose(entry: WindowEntry) {
  void manager.value.closeWindowSafely(entry.id, (title, message) =>
    new Promise<boolean>((resolve) => { pendingConfirm.value = { title, message, resolve } }))
}

// Registers this card's slot for the owning DesktopSessionHost to teleport
// that window's live content into — same pattern as MachinesOverview's
// per-realm preview, keyed by window id instead of realm.
function setPreviewTarget(windowId: string, el: Element | null) {
  if (el) windowsOverviewStore.registerPreviewTarget(windowId, el as HTMLElement)
  else windowsOverviewStore.unregisterPreviewTarget(windowId)
}
</script>

<template>
  <OverviewGrid
    title="Open Apps"
    :entries="entries"
    :active-id="manager.focusedId.value"
    show-back
    closable
    carousel
    empty-message="No apps open"
    @select="onSelect"
    @close="onClose"
    @back="goBack"
  >
    <template #actions>
      <button class="home-btn" title="Home" aria-label="Home" @click.stop="goHome">
        <i class="bi bi-house"></i>
      </button>
    </template>

    <template #preview="{ entry }">
      <div class="preview-slot" :ref="(el) => setPreviewTarget(entry.id, el as Element | null)"></div>
    </template>

    <template #badge="{ entry }">
      <div class="icon-badge" :style="{ color: entry.iconColor, background: entry.iconBg }">
        <i class="bi" :class="entry.icon"></i>
      </div>
    </template>

    <template #label="{ entry }">
      <div class="overview-label">{{ entry.title }}</div>
      <span v-if="entry.minimized" class="overview-minimized">Minimized</span>
    </template>
  </OverviewGrid>

  <div v-if="pendingConfirm" class="confirm-host">
    <ConfirmDialog
      open
      :title="pendingConfirm.title"
      :message="pendingConfirm.message"
      confirm-label="Close"
      @confirm="answerConfirm(true)"
      @cancel="answerConfirm(false)"
    />
  </div>
</template>

<style scoped>
/* ConfirmDialog's overlay fills its nearest positioned ancestor — this makes
   that the whole viewport. */
.confirm-host {
  position: fixed;
  inset: 0;
  z-index: 2000;
}

.home-btn {
  display: none;
}

/* Same look as OverviewGrid's close button, beside it. */
@media (max-width: 767px) {
  .home-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    margin-left: auto;
    margin-right: 0.5rem;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    font-size: 1.05rem;
  }
}

.preview-slot {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

.icon-badge {
  position: absolute;
  left: 8px;
  bottom: 8px;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
}
</style>
