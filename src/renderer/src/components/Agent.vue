<script setup lang="ts">
import { useAgentStore } from '@renderer/store/agent'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'
import { watch, nextTick } from 'vue'

const logger = ref<HTMLElement>()
const agentStore = useAgentStore()
const { logs, active, flashItem: activeItem, dockerInfoDialog } = storeToRefs(agentStore)

watch(logs, () => {
  nextTick(() => {
    logger.value?.lastElementChild?.scrollIntoView()
  })
})
</script>
<template>
  <v-dialog v-model="active" scrollable persistent max-width="880px">
    <v-card class="dlg">
      <div class="dlg__head">
        <span class="icon-tile">
          <v-icon size="20">mdi-console</v-icon>
        </span>
        <h2 class="dlg__title">
          {{ $t('agent.currently_running', { name: activeItem?.reswarm?.config?.name }) }}
        </h2>
      </div>

      <v-card-text class="dlg__body">
        <div ref="logger" class="terminal">
          <div v-html="item" v-for="(item, index) in logs" :key="index"></div>
        </div>
      </v-card-text>

      <div class="dlg__foot">
        <v-btn class="btn-secondary" variant="outlined" @click="agentStore.stopDevice()">
          {{ $t('close') }}
        </v-btn>
      </div>
    </v-card>
  </v-dialog>

  <v-dialog
    max-width="520px"
    v-model="dockerInfoDialog"
    @update:model-value="agentStore.setDockerInfoDialog(false)"
  >
    <v-card class="dlg">
      <div class="dlg__head">
        <span class="icon-tile docker__tile">
          <v-icon size="20">mdi-docker</v-icon>
        </span>
        <h2 class="dlg__title">{{ $t('docker_is_not_running') }}</h2>
        <v-btn
          class="btn-ghost"
          icon="mdi-close"
          size="small"
          variant="text"
          :aria-label="$t('close')"
          @click="agentStore.setDockerInfoDialog(false)"
        ></v-btn>
      </div>

      <div class="dlg__body docker__body">
        <p v-html="$t('docker_is_required')"></p>
        <i18n-t keypath="docker_please_follow_instructions" tag="p">
          <template v-slot:anchor>
            <a href="https://docs.docker.com/get-docker/" target="_blank">{{
              $t('here').toLowerCase()
            }}</a>
          </template>
        </i18n-t>
        <p v-html="$t('make_sure_docker_is_running')"></p>
      </div>
    </v-card>
  </v-dialog>
</template>
<style scoped>
/* Logs arrive as HTML from ansi-to-html (light background, dark text). */
.terminal {
  min-height: 240px;
  padding: 12px 16px;
  border: 1px solid var(--line-200);
  border-radius: var(--radius-md);
  background: var(--surface-50);
  color: var(--ink-900);
  font: 400 13px/20px var(--font-mono);
  white-space: pre-wrap;
  word-break: break-word;
}

.docker__tile {
  background: var(--blue-100);
  color: var(--blue-600);
}

.docker__body {
  gap: 12px;
  color: var(--ink-700);
}

.docker__body p {
  margin: 0;
}

.docker__body :deep(strong) {
  font-weight: 600;
  color: var(--ink-900);
}
</style>
