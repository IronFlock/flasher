<script setup lang="ts">
import humanizeDuration from 'humanize-duration'
import { useFlashStore } from '@renderer/store/flash'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import prettyBytes from 'pretty-bytes'

const props = defineProps({
  id: Number
})

const flashStore = useFlashStore()
const { flashItemById } = storeToRefs(flashStore)

const flashItem = computed(() => flashItemById.value(props.id ?? 0))

const shortEnglishHumanizer = humanizeDuration.humanizer({
  language: 'shortEn',
  languages: {
    shortEn: {
      y: () => 'y',
      mo: () => 'mo',
      w: () => 'w',
      d: () => 'd',
      h: () => 'h',
      m: () => 'm',
      s: () => 's',
      ms: () => 'ms'
    }
  }
})

const progressLabel = computed(() => (flashItem.value?.flash.progress ?? 0).toFixed(2) + ' %')
const speedLabel = computed(() => prettyBytes(flashItem.value?.flash.speed ?? 0) + '/s')
const etaLabel = computed(() =>
  shortEnglishHumanizer(Math.round(flashItem.value?.flash.eta ?? 0) * 1000)
)
</script>
<template>
  <!-- Stat tiles (design spec §2.10): label, value. -->
  <div class="stats">
    <div class="stat">
      <span class="stat__k">{{ $t('completed') }}</span>
      <span class="stat__v">{{ progressLabel }}</span>
    </div>
    <div class="stat">
      <span class="stat__k">{{ $t('speed') }}</span>
      <span class="stat__v">{{ speedLabel }}</span>
    </div>
    <div class="stat">
      <span class="stat__k">{{ $t('eta') }}</span>
      <span class="stat__v">{{ etaLabel }}</span>
    </div>
  </div>
</template>
