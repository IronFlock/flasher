<script setup lang="ts">
import { useFlashStore } from '@renderer/store/flash'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

const props = defineProps({
  id: Number
})

const flashStore = useFlashStore()
const { flashItemById } = storeToRefs(flashStore)

const flashItem = computed(() => flashItemById.value(props.id ?? 0))
const state = computed(() => flashItem.value?.flash.state)

// Final states as status chips: always dot + word (design spec §2.5).
const result = computed(() => {
  switch (state.value) {
    case 'finished':
      return { tone: 'online', text: 'ready_to_use' }
    case 'verification-canceled':
      return { tone: 'online', text: 'verification_canceled' }
    case 'failed':
      return { tone: 'offline', text: 'flashing_failed' }
    case 'flashing-canceled':
      return { tone: 'offline', text: 'flashing_canceled' }
    default:
      return undefined
  }
})

const measured = computed(() =>
  ['flashing', 'verifying', 'decompressing', 'downloading'].includes(state.value ?? '')
)
const waiting = computed(() => ['configuring', 'starting'].includes(state.value ?? ''))
const percent = computed(() => Math.min(100, Math.max(0, flashItem.value?.flash.progress ?? 0)))
</script>
<template>
  <div class="flash-state" role="status">
    <span v-if="result" class="chip" :class="`chip--${result.tone}`">
      <span class="dot"></span>
      {{ $t(result.text) }}
    </span>

    <template v-else-if="measured || waiting">
      <div class="flash-state__label">
        <span>{{ $t(`flashing_state.${state}`) }}</span>
        <span v-if="measured" class="num">{{ percent.toFixed(1) }} %</span>
      </div>
      <div v-if="measured" class="meter">
        <div class="meter__fill" :style="{ width: `${percent}%` }"></div>
      </div>
      <v-progress-linear
        v-else
        indeterminate
        color="primary"
        bg-color="surface-light"
        bg-opacity="1"
        height="6"
        rounded
      ></v-progress-linear>
    </template>
  </div>
</template>
<style scoped>
.flash-state {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-height: 40px;
}

.flash-state > .chip {
  align-self: center;
}

.flash-state__label {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font: 500 13px/18px var(--font-sans);
  color: var(--ink-700);
}
</style>
