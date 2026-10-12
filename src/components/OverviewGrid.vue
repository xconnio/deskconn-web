<script setup lang="ts" generic="T extends { id: string }">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useEntryNavigation } from '@/composables/useEntryNavigation'

// Shared by MachinesOverview and the Open Windows page — same sticky-header
// + responsive 2-up-on-mobile card grid + keyboard nav, so a layout fix (or
// the mobile treatment itself) only has to be made once. Callers supply the
// per-card preview/badge/label content via slots; everything else (grid,
// header, selection, keyboard nav) lives here.

const props = defineProps<{
  title: string
  entries: T[]
  /** Marks one entry with the persistent "active" border (e.g. the machine
   * that's actually open, or the currently-focused window) — independent of
   * keyboard-nav selection below. */
  activeId?: string | null
  /** Shows a per-card close (x) button, emitting `close`. */
  closable?: boolean
  /** Shows the header's back button, emitting `back`. */
  showBack?: boolean
  emptyMessage?: string
}>()

const emit = defineEmits<{
  select: [entry: T]
  close: [entry: T]
  back: []
}>()

const gridRef = ref<HTMLElement | null>(null)
const selected = ref<T | null>(null)

// Keyboard nav starts from the active entry (if any) rather than jumping to
// the first card — set once, as soon as the list carries it, and left alone
// after that so it doesn't fight the user's own navigation.
watch(
  () => props.entries,
  (list) => {
    if (selected.value) return
    const active = list.find((e) => e.id === props.activeId)
    if (active) selected.value = active
  },
  { immediate: true },
)

const { handleNavKey } = useEntryNavigation({
  entries: () => props.entries,
  getKey: (e) => e.id,
  selected,
  listRef: gridRef,
  isGrid: () => true,
  onOpen: (e) => emit('select', e),
  activeSelector: '.overview-card.kbd-focused',
})

// Capture phase + stopPropagation so this consumes the key before it also
// reaches the desktop's own document-level keydown listener underneath.
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.stopPropagation(); emit('back'); return }
  if (handleNavKey(e)) e.stopPropagation()
}

onMounted(() => window.addEventListener('keydown', onKeydown, true))
onUnmounted(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <div class="overview" @contextmenu.prevent>
    <div class="overview-header">
      <h2 class="overview-title">{{ title }}</h2>
      <button v-if="showBack" class="overview-close" title="Close" @click="emit('back')">
        <i class="bi bi-x-lg"></i>
      </button>
    </div>

    <div ref="gridRef" class="overview-grid">
      <div
        v-for="entry in entries"
        :key="entry.id"
        class="overview-card"
        :class="{
          'overview-card-active': entry.id === activeId,
          'kbd-focused': selected?.id === entry.id,
        }"
        tabindex="-1"
        @click="emit('select', entry)"
      >
        <span
          v-if="closable"
          class="overview-close-card"
          title="Close"
          @click.stop="emit('close', entry)"
        >
          <i class="bi bi-x"></i>
        </span>

        <div class="overview-preview">
          <slot name="preview" :entry="entry" />
          <slot name="badge" :entry="entry" />
        </div>

        <slot name="label" :entry="entry" />
      </div>

      <div v-if="entries.length === 0" class="overview-empty">{{ emptyMessage ?? 'Nothing to show' }}</div>
    </div>
  </div>
</template>

<style scoped>
.overview {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #0f172a;
  overflow-y: auto;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

/* Sticky, not part of the scrolling flow — the grid scrolls under it. */
.overview-header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  padding: 2.5rem 3rem 1.5rem;
  background: #0f172a;
}

.overview-title {
  color: #fff;
  font-weight: 700;
  margin: 0;
}

.overview-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-size: 1rem;
  cursor: pointer;
  transition: background 0.15s ease;
}

.overview-close:hover {
  background: rgba(255, 255, 255, 0.22);
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 220px);
  gap: 1.75rem;
  align-content: flex-start;
  padding: 0 3rem 2.5rem;
}

.overview-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  width: 220px;
  padding: 0.9rem;
  border-radius: 14px;
  cursor: pointer;
  border: 2px solid transparent;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
  /* Keyboard nav's scrollIntoView doesn't know the header is sticky/opaque —
     without this, scrolling a top-row card into view tucks it right behind
     the header, hiding its focus outline. */
  scroll-margin-top: 110px;
}

.overview-card:focus {
  outline: none;
}

.overview-card.kbd-focused .overview-preview {
  outline: 2px solid #60a5fa;
  outline-offset: 3px;
}

/* hover:hover excludes touch — without it, a tapped card's hover state
   never clears (no mouseleave on touch), leaving it visibly shifted up. */
@media (hover: hover) {
  .overview-card:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .overview-card:hover .overview-preview {
    border-color: rgba(255, 255, 255, 0.6);
    transform: translateY(-3px);
  }
}

.overview-card-active .overview-preview {
  border-color: #3b82f6;
}

.overview-preview {
  position: relative;
  width: 100%;
  aspect-ratio: 220 / 138;
  border-radius: 10px;
  overflow: hidden;
  background: #1e293b;
  border: 2px solid rgba(255, 255, 255, 0.15);
  transition:
    border-color 0.15s ease,
    transform 0.15s ease;
}

/* Slot content (the label/badge/preview a caller provides) renders with the
   caller's own scope id, not this component's — :deep() is required to
   reach it. See https://vuejs.org/api/sfc-css-features.html#deep-selectors */
:deep(.overview-label) {
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

:deep(.overview-minimized) {
  font-size: 0.68rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.55);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.overview-close-card {
  position: absolute;
  top: -8px;
  right: -8px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #1e293b;
  color: #fff;
  font-size: 0.85rem;
  transition:
    opacity 0.15s ease,
    background 0.15s ease;
}

/* No hover on touch — show it outright, or there'd be no way to reveal it. */
@media (hover: hover) {
  .overview-close-card {
    opacity: 0;
  }

  .overview-card:hover .overview-close-card {
    opacity: 1;
  }
}

.overview-close-card:hover {
  background: #dc2626;
}

.overview-empty {
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.9rem;
}

/* Chrome-style tab-switcher grid: exactly 2 cards per row, sized to fill the
   available width instead of the desktop's fixed 220px tiles. Must come
   after the fixed-size rules above — same specificity, so source order
   decides, and this needs to win at this breakpoint. */
@media (max-width: 575.98px) {
  .overview-header {
    padding: 1rem 1rem 0.6rem;
  }

  .overview-title {
    font-size: 1.25rem;
  }

  .overview-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 0.85rem;
    /* Generous top padding, not 0 — the focused card's outline bleeds a few
       px above its own box (outline-offset), and with no clearance here that
       lands right under the sticky header, which paints over it (higher
       z-index). */
    padding: 2rem 1rem 1.5rem;
  }

  .overview-card {
    /* Grid items default to min-width:auto, which lets the aspect-ratio
       preview below force this wider than its 1fr track — override it. */
    min-width: 0;
    width: 100%;
    /* Shorter header at this breakpoint (see .overview-header above). */
    scroll-margin-top: 76px;
  }
}
</style>
