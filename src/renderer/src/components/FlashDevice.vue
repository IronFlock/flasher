<script setup lang="ts">
import { useFlashStore } from '@renderer/store/flash'
import { storeToRefs } from 'pinia'

const props = defineProps({
  id: Number
})

const flashStore = useFlashStore()
const { flashItemById } = storeToRefs(flashStore)

const flashItem = flashItemById.value(props.id ?? 0)
</script>
<template>
  <div class="container">
    <!-- -------------------- final flash result -------------------- -->

    <div class="flashSeg">
      <v-alert
        v-if="flashItem?.flash.state === 'finished'"
        class="ma-0 mp-0 text-center"
        type="success"
        density="compact"
      >
        {{ $t('ready_to_use') }}
      </v-alert>
      <v-alert
        class="ma-0 mp-0 text-center"
        type="error"
        density="compact"
        v-if="flashItem?.flash.state === 'failed'"
      >
        {{ $t('flashing_failed') }}
      </v-alert>
      <v-alert
        class="ma-0 mp-0 text-center"
        type="info"
        color="error"
        density="compact"
        v-if="flashItem?.flash.state === 'flashing-canceled'"
      >
        {{ $t('flashing_canceled') }}
      </v-alert>
      <v-alert
        class="ma-0 mp-0 text-center"
        type="success"
        density="compact"
        v-if="flashItem?.flash.state === 'verification-canceled'"
      >
        {{ $t('verification_canceled') }}
      </v-alert>
    </div>

    <!-- -------------------- flash process -------------------- -->

    <div
      class="flashSeg"
      v-if="
        flashItem?.flash.state == 'flashing' ||
        flashItem?.flash.state == 'verifying' ||
        flashItem?.flash.state == 'decompressing' ||
        flashItem?.flash.state == 'downloading'
      "
    >
      <v-progress-linear
        class="flash-prog"
        v-model="flashItem.flash.progress"
        color="secondary"
        rounded
        height="40"
      >
        {{
          flashItem?.flash.progress.toFixed(1) +
          ' % ' +
          $t(`flashing_state.${flashItem?.flash.state}`)
        }}
      </v-progress-linear>
    </div>

    <div
      class="flashSeg"
      v-if="flashItem?.flash.state == 'configuring' || flashItem?.flash.state == 'starting'"
    >
      <v-progress-linear class="flash-prog" indeterminate color="secondary" rounded height="40">
        {{ $t(`flashing_state.${flashItem?.flash.state}`) }}
      </v-progress-linear>
    </div>
  </div>
</template>
<style>
.container {
  width: 100%;
  margin-left: auto;
  margin-bottom: 12px;
  padding-right: 34px;
  padding-left: 34px;
  margin-right: auto;
}
</style>
