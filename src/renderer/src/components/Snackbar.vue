<script setup lang="ts">
import { useSnackStore } from '@renderer/store/snack'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

const snackbar = useSnackStore()
const { visible, text, raw, color } = storeToRefs(snackbar)

// Toast recipe (design spec §2.5): brand-900 by default, tinted for errors.
const isError = computed(() => color.value === 'error')
</script>

<template>
  <v-snackbar
    v-model="visible"
    multi-line
    location="bottom right"
    :content-class="['toast', { 'toast--error': isError }]"
  >
    <div class="toast__body">
      <v-icon>{{ isError ? 'mdi-alert-circle-outline' : 'mdi-information-outline' }}</v-icon>
      <span>{{ raw ? text : $t(text) }}</span>
    </div>

    <template v-slot:actions>
      <v-btn
        icon="mdi-close"
        size="small"
        variant="text"
        :aria-label="$t('close')"
        @click="snackbar.setVisible(false)"
      ></v-btn>
    </template>
  </v-snackbar>
</template>
