import { ref } from 'vue'
import { defineStore } from 'pinia'

export interface Shortcut {
  /** KeyboardEvent.code, so it's layout-independent (⌥] on a Mac types ‘). */
  code: string
  alt?: boolean
  shift?: boolean
}

export interface Command {
  id: string
  label: string
  group: string
  icon: string
  /** Tints the icon tile, like the dock's app icons. */
  iconBg?: string
  /** Extra words to match on that aren't in the label. */
  keywords?: string
  /** Runs the command from anywhere, palette closed, and is shown on its row. */
  shortcut?: Shortcut
  /** Display-only keys, for a shortcut the app itself already handles. */
  keys?: string[]
  run: () => void
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
/** How apps label their Ctrl-or-Cmd shortcuts. */
export const MOD = isMac ? '⌘' : 'Ctrl'

/** What an app window exposes (defineExpose) for the palette to list while it's focused. */
export interface PaletteCommandSource {
  commands?: Command[]
}

export const useCommandPaletteStore = defineStore('commandPalette', () => {
  const isOpen = ref(false)
  // Each mounted DesktopSessionHost publishes its own machine's commands
  // (launch app, switch window) here; the palette shows the current route's.
  const realmCommands = ref<Record<string, Command[]>>({})

  function setRealmCommands(realm: string, commands: Command[] | null) {
    const next = { ...realmCommands.value }
    if (commands) next[realm] = commands
    else delete next[realm]
    realmCommands.value = next
  }

  return { isOpen, realmCommands, setRealmCommands }
})
