<script setup lang="ts">
import { ref } from 'vue'
import prettyBytes from 'pretty-bytes'
import { useDrivesStore } from '../store/drives'

const store = useDrivesStore()
const platform = ref()

async function getPlatform() {
  platform.value = await window.api.getPlatform()
}

getPlatform()

const isCard = (busType?: string) => busType === 'SD' || busType === 'MMC'
</script>
<template>
  <div class="drawer">
    <div class="panel-head">
      <div>
        <h2 class="t-heading">{{ $t('flash_drives') }}</h2>
        <p class="t-meta">{{ $t('sd_cards_and_drives') }}</p>
      </div>
      <v-tooltip>
        <template v-slot:activator="{ props }">
          <v-btn
            v-bind="props"
            class="btn-ghost"
            icon="mdi-refresh"
            size="small"
            variant="text"
            :aria-label="$t('refresh_drive_list')"
            @click="store.fetchDrives"
          ></v-btn>
        </template>
        <span>{{ $t('refresh_drive_list') }}</span>
      </v-tooltip>
    </div>

    <div v-if="store.drives.length" class="list-card">
      <div v-for="item in store.drives" :key="item.device" class="row">
        <span class="icon-tile">
          <v-icon size="20">
            {{ isCard(item.busType) ? 'mdi-sd' : 'mdi-usb-flash-drive-outline' }}
          </v-icon>
        </span>

        <div class="row__text">
          <span class="row__title">{{ item.description }}</span>
          <span class="row__meta">
            <span class="mono">{{ item.device }}</span> · {{ prettyBytes(item.size ?? 0) }}
          </span>
        </div>

        <template v-if="platform !== 'win32'">
          <v-tooltip v-if="!item.mountpoints.length">
            <template v-slot:activator="{ props }">
              <v-btn
                v-bind="props"
                class="btn-ghost"
                icon="mdi-eject mdi-rotate-180"
                size="small"
                variant="text"
                :aria-label="$t('mount')"
                @click="store.mountDrive(item)"
              ></v-btn>
            </template>
            <span>{{ $t('mount') }}</span>
          </v-tooltip>

          <v-tooltip v-else>
            <template v-slot:activator="{ props }">
              <v-btn
                v-bind="props"
                class="btn-ghost"
                icon="mdi-eject"
                size="small"
                variant="text"
                :aria-label="$t('unmount')"
                @click="store.unmountDrive(item)"
              ></v-btn>
            </template>
            <span>{{ $t('unmount') }}</span>
          </v-tooltip>
        </template>
      </div>
    </div>

    <p v-else class="t-meta drawer__empty">{{ $t('no_drives_available') }}</p>
  </div>
</template>
<style scoped>
.drawer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 16px;
}

.panel-head {
  padding-left: 4px;
}

.drawer__empty {
  padding-left: 4px;
}
</style>
