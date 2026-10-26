import type { InjectionKey } from 'vue'
import type { FileEntry } from '@/types'
import type { GitFileStatus } from '@/utils/git'

/** Shared tree state/actions provided by EditorFileTree.vue (the root) and
 * consumed by EditorFileTreeNode.vue at every recursion depth — avoids prop
 * drilling the same handful of callbacks through every nesting level. */
export interface EditorFileTreeActions {
  isExpanded(path: string): boolean
  childrenOf(path: string): FileEntry[] | undefined
  isLoading(path: string): boolean
  statusOf(path: string): GitFileStatus | undefined
  toggleDir(path: string): void
  openFile(entry: FileEntry): void
  openFilePinned(entry: FileEntry): void
  /** A file row started being dragged (e.g. onto the editor to open/split). */
  dragFile(entry: FileEntry): void
  isSelected(path: string): boolean
  select(path: string): void
}

export const editorFileTreeActionsKey: InjectionKey<EditorFileTreeActions> = Symbol('editorFileTreeActions')
