<script setup lang="ts">
import { useSettingsStore } from '@/stores/settings'

const settingsStore = useSettingsStore()
</script>

<template>
  <div class="container py-0">
    <div class="row justify-content-center">
      <div class="col-lg-10">
        <h6 class="discord-group-heading">Preferences</h6>

        <div class="discord-row">
          <div class="discord-row-value">Single click to open</div>
          <div class="form-check form-switch mb-0">
            <input
              class="form-check-input settings-toggle"
              type="checkbox"
              role="switch"
              id="singleClickToggle"
              :checked="settingsStore.singleClickOpen"
              @change="settingsStore.setSingleClickOpen(($event.target as HTMLInputElement).checked)"
            />
            <label class="form-check-label visually-hidden" for="singleClickToggle">
              Single click to open
            </label>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-toggle {
  width: 3rem;
  height: 1.6rem;
  cursor: pointer;
}
</style>
