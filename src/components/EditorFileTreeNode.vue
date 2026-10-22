<script setup lang="ts">
// Recursive: renders one row and, if expanded, its children via itself again.
// Requires no explicit registration — Vite/Vue infer a script-setup SFC's
// recursion name from its filename.
defineOptions({ name: 'EditorFileTreeNode' })

import { computed, inject } from 'vue'
import type { FileEntry } from '@/types'
import { editorFileTreeActionsKey } from '@/composables/editorFileTreeActions'
import { fileIconUrl } from '@/utils/fileIcons'

const props = defineProps<{
  entry: FileEntry
  depth: number
}>()

const actions = inject(editorFileTreeActionsKey)!

const isExpanded = computed(() => actions.isExpanded(props.entry.path))
const children = computed(() => actions.childrenOf(props.entry.path))
const isLoading = computed(() => actions.isLoading(props.entry.path))
const gitStatus = computed(() => actions.statusOf(props.entry.path))

const isSelected = computed(() => actions.isSelected(props.entry.path))
// Files get a VS Code-style language icon; git status still colors the name.
const fileIcon = computed(() => (props.entry.is_dir ? null : fileIconUrl(props.entry.name)))

function onClick() {
  actions.select(props.entry.path)
  if (props.entry.is_dir) {
    actions.toggleDir(props.entry.path)
  } else {
    actions.openFile(props.entry)
  }
}

function onDblClick() {
  if (!props.entry.is_dir) actions.openFilePinned(props.entry)
}
</script>

<template>
  <div
    class="tree-row"
    :class="{
      'tree-row-untracked': gitStatus === 'untracked' || gitStatus === 'added',
      'tree-row-modified': gitStatus === 'modified',
      'tree-row-ignored': gitStatus === 'ignored',
      'tree-row-selected': isSelected,
    }"
    :data-path="entry.path"
    :style="{ paddingLeft: `${depth * 14 + 8}px` }"
    @click="onClick"
    @dblclick="onDblClick"
  >
    <i
      v-if="entry.is_dir"
      class="bi tree-caret"
      :class="isExpanded ? 'bi-chevron-down' : 'bi-chevron-right'"
    ></i>
    <span v-else class="tree-caret-spacer"></span>
    <img v-if="fileIcon" :src="fileIcon" alt="" class="tree-file-icon" />
    <i v-else class="bi bi-folder-fill tree-icon"></i>
    <span class="tree-name">{{ entry.name }}</span>
    <span v-if="isLoading" class="spinner-border spinner-border-sm tree-spinner" role="status"></span>
  </div>

  <template v-if="entry.is_dir && isExpanded && children">
    <EditorFileTreeNode
      v-for="child in children"
      :key="child.path"
      :entry="child"
      :depth="depth + 1"
    />
  </template>
</template>

<style scoped>
.tree-row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding-top: 0.28rem;
  padding-bottom: 0.28rem;
  padding-right: 0.5rem;
  font-size: 0.8rem;
  color: #d4d4d4;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.tree-row:hover {
  background: rgba(255, 255, 255, 0.06);
}
.tree-row-selected {
  background: rgba(255, 255, 255, 0.1);
}
.tree-row-untracked,
.tree-row-untracked .tree-name {
  color: #f87171;
}
.tree-row-modified,
.tree-row-modified .tree-name {
  color: #7fb4e0;
}
.tree-row-ignored,
.tree-row-ignored .tree-name {
  color: #f59e0b;
}

.tree-caret {
  font-size: 0.65rem;
  width: 12px;
  flex-shrink: 0;
  color: #8a8a85;
}
.tree-caret-spacer {
  width: 12px;
  flex-shrink: 0;
}

.tree-icon {
  font-size: 0.85rem;
  flex-shrink: 0;
  color: #75a3d1;
}
.tree-row-untracked .tree-icon {
  color: #f87171;
}
.tree-row-modified .tree-icon {
  color: #7fb4e0;
}
.tree-row-ignored .tree-icon {
  color: #f59e0b;
}

.tree-file-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.tree-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-spinner {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
  color: #8a8a85;
  flex-shrink: 0;
}
</style>
