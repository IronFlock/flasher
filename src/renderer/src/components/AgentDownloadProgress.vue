<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAgentStore } from '@renderer/store/agent'

// Non-modal feedback for the background IronFlock device agent download. The
// download can begin at app launch; useAgentStore() seeds the current status so
// progress shows even if it started before this component mounted.
const agentStore = useAgentStore()
const { downloadState, downloadProgress } = storeToRefs(agentStore)

const visible = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | undefined

const isDownloading = computed(() => downloadState.value === 'downloading')

const percentage = computed(() => {
  const p = downloadProgress.value?.percentage ?? 0
  if (!Number.isFinite(p)) return 0
  return Math.min(100, Math.max(0, Math.round(p)))
})

const color = computed(() => {
  switch (downloadState.value) {
    case 'failed':
      return 'error'
    case 'finished':
      return 'success'
    default:
      return 'primary'
  }
})

const message = computed(() => {
  switch (downloadState.value) {
    case 'downloading':
      return 'agent.downloading'
    case 'finished':
      return 'agent.download_finished'
    case 'failed':
      return 'agent.download_failed'
    default:
      return ''
  }
})

// Stay open while downloading; auto-dismiss the terminal states after a moment.
watch(
  downloadState,
  (state) => {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = undefined
    }

    if (state === 'downloading') {
      visible.value = true
    } else if (state === 'finished' || state === 'failed') {
      visible.value = true
      hideTimer = setTimeout(() => (visible.value = false), state === 'failed' ? 5000 : 2500)
    } else {
      visible.value = false
    }
  },
  { immediate: true }
)
</script>

<template>
  <v-snackbar v-model="visible" :timeout="-1" location="bottom" :color="color">
    <div class="d-flex flex-column" style="min-width: 240px">
      <div class="d-flex align-center justify-space-between">
        <span>{{ message ? $t(message) : '' }}</span>
        <span v-if="isDownloading" class="ml-4">{{ percentage }}%</span>
      </div>
      <v-progress-linear
        v-if="isDownloading"
        class="mt-2"
        :model-value="percentage"
        color="accent"
        height="6"
        rounded
      />
    </div>
  </v-snackbar>
</template>
