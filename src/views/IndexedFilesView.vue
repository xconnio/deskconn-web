<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import { useMachinesStore } from '@/stores/machines'
import EmbeddedIndexedFiles from '@/components/EmbeddedIndexedFiles.vue'
import { openFiles } from '@/router/navigation'

const route = useRoute()
const machinesStore = useMachinesStore()

const realm = computed(() => route.params.realm as string)
const category = computed(() => route.params.category as string)
const desktopName = computed(() => {
  const n = route.query.name as string
  if (n) return n
  return machinesStore.desktops.find((d) => d.realm === realm.value)?.name ?? realm.value
})

function onOpenFiles(path: string) {
  openFiles(realm.value, desktopName.value, path)
}
</script>

<template>
  <div class="indexed-files-page fade-in-up">
    <EmbeddedIndexedFiles
      :realm="realm"
      :category="category"
      :desktop-name="desktopName"
      :focused="true"
      @open-files="onOpenFiles"
    />
  </div>
</template>

<style scoped>
.indexed-files-page {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 0 1rem 1.5rem;
}

@media (min-width: 768px) {
  .indexed-files-page {
    padding: 0 1.75rem 1.5rem;
    min-height: var(--app-viewport-height, 100dvh);
    box-sizing: border-box;
  }
}
</style>
