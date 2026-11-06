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

const icon = computed(() => {
  switch (downloadState.value) {
    case 'failed':
      return 'mdi-alert-circle-outline'
    case 'finished':
      return 'mdi-check-circle-outline'
    default:
      return 'mdi-download-outline'
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
  <v-snackbar
    v-model="visible"
    :timeout="-1"
    location="bottom right"
    :content-class="['toast', { 'toast--error': downloadState === 'failed' }]"
  >
    <div class="agent-progress">
      <div class="toast__body">
        <v-icon>{{ icon }}</v-icon>
        <span class="agent-progress__text">{{ message ? $t(message) : '' }}</span>
        <span v-if="isDownloading" class="num">{{ percentage }} %</span>
      </div>
      <div v-if="isDownloading" class="agent-progress__meter">
        <div class="agent-progress__fill" :style="{ width: `${percentage}%` }"></div>
      </div>
    </div>
  </v-snackbar>
</template>
<style scoped>
.agent-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 260px;
}

.agent-progress__text {
  flex: 1;
}

/* A meter on the dark toast: a light track, a light fill. */
.agent-progress__meter {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.2);
  overflow: hidden;
}

.agent-progress__fill {
  height: 100%;
  border-radius: inherit;
  background: #d9cffa; /* primary-200 of the light ramp: the toast is dark in both themes */
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
</style>
