<script setup lang="ts">
/**
 * Shared titlebar tab strip for TerminalPanel and TextEditor — the two apps'
 * tabs only ever differed in the dirty-dot and preview-italic decorations
 * (both optional per-tab flags here), everything else (equal-width sizing,
 * scroll chevrons, hover/active look, close button) is identical chrome.
 */
import { ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useTabScroll } from '@/composables/useTabScroll'

interface TabStripTab {
  id: number
  label: string
  /** Shows the amber unsaved-changes dot before the label (TextEditor only). */
  dirty?: boolean
  /** Italicizes the label for VS Code-style "preview" tabs (TextEditor only). */
  preview?: boolean
}

const props = defineProps<{
  tabs: TabStripTab[]
  activeId: number | null
  newTabTitle: string
  /** Lets tabs be dragged out (TextEditor drops them into a split pane). */
  draggableTabs?: boolean
}>()

const emit = defineEmits<{
  switch: [id: number]
  close: [id: number, event?: MouseEvent]
  add: []
  'drag-start': [id: number]
}>()

const { tabsListRef, tabsScrollLeft, tabsScrollMax, updateTabsScroll, scrollTabsBy, scrollTabsToEnd } = useTabScroll()

// Equal-width tabs (GNOME/Yaru style): every tab gets the same share of the
// available width, shrinking as more are added, capped between 80 and 160px.
const tabWidth = ref(160)
function updateTabsLayout() {
  updateTabsScroll()
  const el = tabsListRef.value
  if (!el) return
  const availableWidth = el.clientWidth
  const count = props.tabs.length
  tabWidth.value = count > 1 && availableWidth > 0
    ? Math.max(80, Math.min(160, Math.floor(availableWidth / count)))
    : 160
}

const tabButtonElMap = new Map<number, HTMLElement>()
function setTabButtonEl(id: number, el: Element | null) {
  if (el) tabButtonElMap.set(id, el as HTMLElement)
  else tabButtonElMap.delete(id)
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  updateTabsLayout()
  if (tabsListRef.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(updateTabsLayout)
    resizeObserver.observe(tabsListRef.value)
  }
})
onUnmounted(() => resizeObserver?.disconnect())

// Scroll the active tab into view whenever it changes. If it just landed at
// the end of a longer list (a brand-new tab), scroll all the way to the end
// instead of just to the tab — otherwise the "+" button right after it would
// still be left off-screen.
watch(
  () => [props.tabs.length, props.activeId] as const,
  ([len, activeId], prev) => {
    const prevLen = prev?.[0] ?? len
    nextTick(() => {
      updateTabsLayout()
      nextTick(() => {
        const isLastTab = props.tabs.length > 0 && props.tabs[props.tabs.length - 1]?.id === activeId
        if (activeId === null) return
        if (len > prevLen && isLastTab) {
          scrollTabsToEnd()
        } else {
          tabButtonElMap.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
      })
    })
  },
)

function onTabsWheel(event: WheelEvent) {
  // Tabs only scroll horizontally, but a normal mouse wheel emits vertical
  // delta — remap it so tabs scroll without needing shift held.
  if (event.deltaY === 0) return
  ;(event.currentTarget as HTMLElement).scrollBy({ left: event.deltaY })
  event.preventDefault()
}

// A prevented mousedown keeps focus where it is (the terminal/textarea), but
// it also blocks a native drag from ever starting — so draggable tabs let it
// through and switch on click instead (a drag never fires one), which also
// keeps the drag from first swapping out the tab the user is dragging beside.
function onTabMouseDown(id: number, e: MouseEvent) {
  if (!props.draggableTabs) e.preventDefault()
  if ((e.target as HTMLElement | null)?.closest('.tab-close')) return
  if (e.button === 1) {
    emit('close', id, e)
    return
  }
  if (!props.draggableTabs) emit('switch', id)
}

function onTabDragStart(tab: TabStripTab, e: DragEvent) {
  e.dataTransfer?.setData('text/plain', tab.label)
  emit('drag-start', tab.id)
}
</script>

<template>
  <div class="tab-bar">
    <button
      v-if="tabsScrollMax > 0"
      class="tab-scroll-btn"
      :disabled="tabsScrollLeft <= 0"
      @click="scrollTabsBy(-160)"
    ><i class="bi bi-chevron-left"></i></button>
    <div
      ref="tabsListRef"
      class="tabs-list"
      :style="{ '--tabstrip-tab-width': `${tabWidth}px` }"
      @wheel="onTabsWheel"
      @scroll="updateTabsScroll"
    >
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :ref="(el) => setTabButtonEl(tab.id, el as Element | null)"
        class="tab-item"
        :class="{ 'tab-active': tab.id === activeId, 'tab-preview': tab.preview }"
        :draggable="draggableTabs"
        @mousedown="onTabMouseDown(tab.id, $event)"
        @mouseup.prevent
        @click="draggableTabs && emit('switch', tab.id)"
        @dragstart="onTabDragStart(tab, $event)"
      >
        <span v-if="tab.dirty" class="tab-dot"></span>
        <span class="tab-label">{{ tab.label }}</span>
        <span
          class="tab-close"
          role="button"
          :title="`Close ${tab.label}`"
          @click.stop="emit('close', tab.id, $event)"
        >&times;</span>
      </button>
      <button class="tab-add" :title="newTabTitle" @click="emit('add')">+</button>
    </div>
    <button
      v-if="tabsScrollMax > 0"
      class="tab-scroll-btn"
      :disabled="tabsScrollLeft >= tabsScrollMax"
      @click="scrollTabsBy(160)"
    ><i class="bi bi-chevron-right"></i></button>
  </div>
</template>

<style scoped>
/* No titlebar-bleed margin here on purpose — TerminalPanel (the strip's only
   content) and TextEditor (strip alongside a "Files" button) sit differently
   inside the titlebar, so each applies its own bleed margin to whichever
   element is the actual direct child of the titlebar (see their own styles). */
.tab-bar {
  display: flex;
  align-items: stretch;
  overflow: hidden;
  flex: 1 1 auto;
  min-width: 0;
}

.tabs-list {
  display: flex;
  align-items: stretch;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  /* The strip sits in a window titlebar and its empty space is the drag
     handle. As a scroller it would otherwise claim finger drags for itself
     and cancel the window move; the chevron buttons still scroll it. */
  touch-action: none;
}
.tabs-list::-webkit-scrollbar { display: none; }

/* GNOME/Yaru style: inactive tabs blend into the bar, the active tab gets a
   lighter "pressed in" panel with a pink accent underline. Equal-width,
   shrinking to fit as more tabs are added (see tabWidth above). */
.tab-item {
  flex: 0 0 var(--tabstrip-tab-width, 160px);
  width: var(--tabstrip-tab-width, 160px);
  max-width: var(--tabstrip-tab-width, 160px);
  min-width: 80px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 8px 0 10px;
  height: 32px;
  background: transparent;
  border: none;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  color: #a9a9a9;
  font-size: 0.72rem;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  transition: background 0.12s, color 0.12s;
}
.tab-item:hover { background: rgba(255, 255, 255, 0.06); color: #e2e8f0; }
.tab-item.tab-active {
  background: #4a4a4a;
  color: #fff;
  box-shadow: inset 0 -2px 0 #ec4899;
}
.tab-item.tab-preview .tab-label { font-style: italic; }

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
}

.tab-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
  white-space: nowrap;
}

.tab-close {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  border-radius: 3px;
  color: inherit;
  font-size: 0.9rem;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.4;
  transition: opacity 0.1s, background 0.1s;
  user-select: none;
}
.tab-close:hover { opacity: 1 !important; background: rgba(255, 255, 255, 0.15); }

.tab-scroll-btn {
  flex: 0 0 28px;
  height: 32px;
  padding: 0;
  background: transparent;
  border: none;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  color: #a9a9a9;
  font-size: 0.65rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
}
.tab-scroll-btn:last-child {
  border-right: none;
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}
.tab-scroll-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.06); color: #e2e8f0; }
.tab-scroll-btn:disabled { opacity: 0.25; cursor: default; }

.tab-add {
  flex: 0 0 28px;
  height: 32px;
  background: transparent;
  border: none;
  color: #a9a9a9;
  font-size: 1.1rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s, color 0.12s;
  border-radius: 3px;
  margin: 2px 2px 2px 1px;
}
.tab-add:hover { background: rgba(255, 255, 255, 0.1); color: #e2e8f0; }
</style>
