<script setup lang="ts">
import { useUpdateStore } from '@renderer/store/update'
import { storeToRefs } from 'pinia'

const updateStore = useUpdateStore()
const { showDialog, updateState, updateProgress, busy } = storeToRefs(updateStore)
</script>
<template>
  <section v-if="showDialog" class="card update" role="status">
    <div class="update__head">
      <span class="icon-tile update__tile">
        <v-icon size="20">mdi-update</v-icon>
      </span>
      <h2 class="t-subheading">{{ $t(`update.${updateState}`) }}</h2>
    </div>

    <div v-if="updateState === 'announce'" class="update__actions">
      <v-btn
        class="btn-secondary"
        variant="outlined"
        :disabled="busy"
        @click="updateStore.setShowDialog(false)"
      >
        {{ $t('dismiss') }}
      </v-btn>
      <v-btn color="primary" :loading="busy" @click="updateStore.downloadUpdate()">
        {{ $t('download') }}
      </v-btn>
    </div>

    <div v-if="updateState === 'download'" class="update__progress">
      <div class="meter">
        <div class="meter__fill" :style="{ width: `${updateProgress}%` }"></div>
      </div>
      <span class="num t-meta">{{ updateProgress.toFixed(1) }} %</span>
    </div>

    <div v-if="updateState === 'install'" class="update__actions">
      <v-btn class="btn-secondary" variant="outlined" @click="updateStore.setShowDialog(false)">
        {{ $t('not_now') }}
      </v-btn>
      <v-btn color="primary" @click="updateStore.installUpdate()">
        {{ $t('install') }}
      </v-btn>
    </div>
  </section>
</template>
<style scoped>
.update {
  position: fixed;
  bottom: 56px;
  left: 16px;
  z-index: 99;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 360px;
  padding: 16px;
  box-shadow: var(--shadow-md);
}

.update__head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.update__tile {
  background: var(--primary-100);
  color: var(--primary-600);
}

.update__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.update__progress {
  display: flex;
  align-items: center;
  gap: 12px;
}

.update__progress .meter {
  flex: 1;
}
</style>
