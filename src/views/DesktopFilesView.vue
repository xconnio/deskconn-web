<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

import EmbeddedDesktopFiles from '@/components/EmbeddedDesktopFiles.vue'

const route = useRoute()

const realm = computed(() => String(route.params.realm || ''))
const desktopName = computed(() => {
  const queryName = route.query.name
  return typeof queryName === 'string' ? queryName : undefined
})
const initialPath = computed(() => {
  const p = route.query.path
  return typeof p === 'string' ? p : undefined
})
</script>

<template>
  <div class="file-explorer-page fade-in-up">
    <EmbeddedDesktopFiles
      :realm="realm"
      :desktop-name="desktopName"
      :initial-path="initialPath"
    />
  </div>
</template>

<style scoped>
.file-explorer-page {
  padding: 0 1rem 1.5rem;
}

@media (min-width: 768px) {
  .file-explorer-page {
    padding: 0 1.75rem 1.5rem;
    min-height: var(--app-viewport-height, 100dvh);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }
}
</style>
