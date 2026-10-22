<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ManifestApp, ManifestScreen, type ManifestCaller } from '@xconnio/app-engine'

import { useCapabilitiesStore } from '@/stores/capabilities'
import { useSessionCacheStore } from '@/stores/sessionCache'
import { encryptedCall } from '@/utils/encryptedCall'
import { formatDesktopError } from '@/utils/desktopError'

// Fetches manifest app appId from the desktop and renders its entry screen. Its calls are
// end-to-end encrypted with the app's key exchange.
const props = defineProps<{ realm: string; appId: string }>()

const capabilitiesStore = useCapabilitiesStore()
const sessionCacheStore = useSessionCacheStore()

const app = ref<ManifestApp>()
const caller = ref<ManifestCaller>()
const error = ref<string>()

const context = computed(() => ({
  capabilities: Object.fromEntries((capabilitiesStore.byRealm[props.realm] ?? []).map((c) => [c.id, c.enabled])),
}))

async function load() {
  error.value = undefined
  try {
    const session = await sessionCacheStore.acquire(props.realm)
    if (!session) throw new Error('Desktop is offline.')
    const result = await session.call('io.xconn.deskconn.manifest.get', [props.appId])
    const loaded = new ManifestApp(result.args?.[0] as Record<string, unknown>)
    caller.value = (procedure, arg) => encryptedCall(session, props.realm, procedure, arg, loaded.keyExchange)
    app.value = loaded
  } catch (e) {
    error.value = formatDesktopError(e)
  }
}

onMounted(load)
</script>

<template>
  <div class="h-100 overflow-auto">
    <div v-if="error" class="p-4 text-center">
      <p>{{ error }}</p>
      <button type="button" class="btn btn-primary btn-sm" @click="load">Retry</button>
    </div>
    <div v-else-if="!app || !caller" class="p-4 text-center">Loading…</div>
    <ManifestScreen
      v-else-if="app.entryScreen"
      :screen="app.entryScreen"
      :context="context"
      :caller="caller"
      :error-uri="formatDesktopError"
    />
  </div>
</template>
