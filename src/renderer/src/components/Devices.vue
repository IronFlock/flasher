<script setup lang="ts">
import Agent from './Agent.vue'
import type { FlashItem, ImageInfo, SupportedBoard } from 'src/types'
import { storeToRefs } from 'pinia'
import { useDrivesStore } from '@renderer/store/drives'
import { Drive } from 'drivelist'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { cutInfoString } from '../utils'
import {
  defaultImage,
  hardwareTitle,
  imageKey,
  installerFor,
  variantImages
} from '../../../shared/images'
import { useBoardStore } from '@renderer/store/boards'
import { useWifiStore } from '@renderer/store/wifi'
import { useFlashStore } from '@renderer/store/flash'
import { useAgentStore } from '@renderer/store/agent'
import FlashDevice from '@renderer/components/FlashDevice.vue'
import FlashDisplay from '@renderer/components/FlashDisplay.vue'
import prettyBytes from 'pretty-bytes'

const drivesStore = useDrivesStore()
const boardStore = useBoardStore()
const wifiStore = useWifiStore()
const flashStore = useFlashStore()
const agentStore = useAgentStore()

const { downloadState } = storeToRefs(agentStore)
const { drives } = storeToRefs(drivesStore)
const { boards, ironflockos } = storeToRefs(boardStore)
const { t } = useI18n()

// Menu 1: the hardware only.
const boardTitle = (board: SupportedBoard) => hardwareTitle(board, boards.value)

// Menu 2: the variants of the chosen hardware, the IronFlockOS version once below.
const variantTitle = (image: ImageInfo) => {
  const variant = t(`variants.${image.variant}`)
  return image.kernel === 'rt' ? `${variant}, ${t('variants.rt')}` : variant
}

const variantHint = (board: SupportedBoard | undefined) => {
  if (!board) return t('choose_hardware_first')
  const version = defaultImage(board.latestImages)?.version
  return version ? `IronFlockOS ${version}` : ''
}

// Menu 3, only when the board's installer stick carries the chosen variant.
const installMethods = computed(() => [
  { value: 'direct', title: t('installation.direct') },
  { value: 'installer', title: t('installation.installer') }
])
const { accessPoints } = storeToRefs(wifiStore)
const { flashItems } = storeToRefs(flashStore)

// One device card is open at a time: its form (idle) or its flash details.
const openId = ref<number | null>(null)
const toggle = (item: FlashItem) => {
  openId.value = openId.value === item.id ? null : item.id
}

const BUSY_STATES = [
  'flashing',
  'downloading',
  'configuring',
  'verifying',
  'starting',
  'decompressing'
]
const REMOVABLE_STATES = [
  'idle',
  'finished',
  'failed',
  'verification-canceled',
  'flashing-canceled'
]
const PROGRESS_STATES = ['decompressing', 'flashing', 'verifying', 'downloading']
const RETRY_STATES = ['finished', 'failed', 'flashing-canceled', 'verification-canceled']

async function addByFilePicker() {
  const { canceled, filePaths } = await window.api.chooseFile()

  if (canceled) return

  const [fullPath] = filePaths

  return flashStore.addItem(fullPath)
}

// A refreshed catalog: keep each device's board and image choice on it.
watch(boards, (list) => flashStore.rebindBoards(list))

// Update drive of flashitem if drive list changes
watch(drives, (updatedDl) => {
  flashItems.value.forEach((fi) => {
    if (fi.drive) {
      const driveInList = updatedDl.find((dr) => dr.device === fi.drive?.device)
      fi.drive = driveInList
    } else {
      fi.drive = updatedDl?.[0]
    }
  })
})
</script>
<template>
  <div class="page">
    <header class="page-head">
      <div class="page-head__row">
        <div>
          <h1 class="t-title">{{ $t('devices') }}</h1>
          <p class="t-meta">{{ $t('devices_list_subtitle') }}</p>
        </div>
        <v-btn color="primary" prepend-icon="mdi-plus" @click="addByFilePicker">
          {{ $t('add_device') }}
        </v-btn>
      </div>

      <v-alert
        v-if="ironflockos && !ironflockos.ok"
        class="banner"
        type="error"
        variant="tonal"
        density="compact"
        :title="
          ironflockos.kept
            ? $t('catalog.kept', { issuedAt: ironflockos.kept.issuedAt })
            : $t('catalog.refused')
        "
        :text="ironflockos.error"
      >
        <template #append>
          <v-btn size="small" variant="text" @click="boardStore.refresh(true)">
            {{ $t('catalog.retry') }}
          </v-btn>
        </template>
      </v-alert>
      <v-alert
        v-else-if="ironflockos?.ok && ironflockos.fromCache"
        class="banner"
        type="info"
        variant="tonal"
        density="compact"
        :text="$t('catalog.offline', { issuedAt: ironflockos.issuedAt })"
      >
        <template #append>
          <v-btn size="small" variant="text" @click="boardStore.refresh(true)">
            {{ $t('catalog.retry') }}
          </v-btn>
        </template>
      </v-alert>
    </header>

    <div class="device-list">
      <article v-for="flashItem in flashItems" :key="flashItem.id" class="card device">
        <!-- -------------------- What gets flashed where -------------------- -->

        <div class="device__info">
          <div v-if="flashItem.flock" class="kv">
            <span class="kv__k">{{ $t('device') }}</span>
            <span class="kv__v">
              {{ cutInfoString(flashItem.flock?.config?.name ?? '', 28, $t('no_device_name')) }}
            </span>
            <span class="kv__s">
              {{ cutInfoString(flashItem.flock?.config?.description ?? '', 32, '') }}
            </span>
          </div>

          <div v-if="flashItem.flock" class="kv">
            <span class="kv__k">{{ $t('swarm') }}</span>
            <span class="kv__v">
              {{ cutInfoString(flashItem.flock?.config?.swarm_name ?? '', 28, $t('no_swarm')) }}
            </span>
            <span class="kv__s">
              {{
                cutInfoString(
                  flashItem.flock?.config?.swarm_owner_name ?? '',
                  32,
                  $t('no_swarm_owner')
                )
              }}
            </span>
          </div>

          <div class="kv">
            <span class="kv__k">{{ $t('drive') }}</span>
            <template v-if="flashItem.drive">
              <span class="kv__v">
                {{ cutInfoString(flashItem.drive.description, 28, $t('name_unknown')) }}
              </span>
              <span class="kv__s">
                <span class="mono">{{ flashItem.drive.device }}</span> ·
                {{ prettyBytes(flashItem.drive.size ?? 0) }}
              </span>
            </template>
            <template v-else>
              <span class="kv__v kv__v--alert">{{ $t('unavailable') }}</span>
              <span class="kv__s">{{ $t('no_drive') }}</span>
            </template>
          </div>

          <div v-if="flashItem.flock" class="kv">
            <span class="kv__k">{{ $t('board') }}</span>
            <template v-if="flashItem.flock.config!.board">
              <span class="kv__v">
                {{ cutInfoString(flashItem.flock.config!.board.modelname, 28) }}
              </span>
              <span>
                <span class="chip">{{ flashItem.flock.config!.board.architecture }}</span>
              </span>
            </template>
            <span v-else class="kv__v kv__v--alert">{{ $t('choose_board') }}</span>
          </div>

          <v-btn
            class="device__remove btn-ghost btn-danger-ghost"
            icon="mdi-close"
            size="small"
            variant="text"
            :aria-label="$t('remove_device')"
            :disabled="!REMOVABLE_STATES.includes(flashItem.flash.state)"
            @click="flashStore.removeItem(flashItem)"
          ></v-btn>
        </div>

        <!-- -------------------- Actions and flash state -------------------- -->

        <div class="device__bar">
          <v-btn
            class="btn-secondary"
            variant="outlined"
            :prepend-icon="
              flashItem.flash.state === 'idle' ? 'mdi-pencil-outline' : 'mdi-information-outline'
            "
            :append-icon="openId === flashItem.id ? 'mdi-chevron-up' : 'mdi-chevron-down'"
            :aria-expanded="openId === flashItem.id"
            @click="toggle(flashItem)"
          >
            {{ flashItem.flash.state === 'idle' ? $t('edit') : $t('details') }}
          </v-btn>

          <div class="device__status">
            <FlashDevice v-if="flashItem.flash.state !== 'idle'" :id="flashItem.id" />
          </div>

          <v-btn
            v-if="flashItem.flock && flashItem.flash.state === 'idle'"
            class="btn-secondary"
            variant="outlined"
            prepend-icon="mdi-play-outline"
            :loading="downloadState === 'downloading'"
            @click="agentStore.testDevice(flashItem)"
          >
            {{ $t('test_device') }}
          </v-btn>

          <v-btn
            color="primary"
            prepend-icon="mdi-flash"
            min-width="112"
            :disabled="BUSY_STATES.includes(flashItem.flash.state) || !flashItem.drive"
            @click="flashStore.flashDevice(flashItem)"
          >
            {{ $t('flash') }}
          </v-btn>
        </div>

        <!-- -------------------- Edit form / flash details -------------------- -->

        <v-expand-transition>
          <div v-if="openId === flashItem.id">
            <div v-if="flashItem.flash.state === 'idle'" class="device__body">
              <div class="form-grid form-grid--3">
                <div class="fld">
                  <label class="fld__label" :for="`drive-${flashItem.id}`">
                    {{ $t('select_drive') }}
                  </label>
                  <v-select
                    :id="`drive-${flashItem.id}`"
                    v-model="flashItem.drive"
                    :items="drives"
                    :item-title="(el: Drive) => `${el.device} · ${prettyBytes(el.size ?? 0)}`"
                    :item-value="(el) => el"
                    :no-data-text="$t('no_drives_available')"
                    hide-details
                  ></v-select>
                </div>

                <div v-if="flashItem.flock" class="fld">
                  <label class="fld__label" :for="`hardware-${flashItem.id}`">
                    {{ $t('choose_hardware') }}
                  </label>
                  <v-select
                    :id="`hardware-${flashItem.id}`"
                    :model-value="flashItem.flock.config!.board"
                    @update:model-value="(board) => flashStore.selectBoard(flashItem, board)"
                    @update:menu="(open: boolean) => open && boardStore.refresh()"
                    :items="boards"
                    :item-title="boardTitle"
                    :item-value="(el) => el"
                    :placeholder="$t('choose_board')"
                    hide-details
                  ></v-select>
                </div>

                <div v-if="flashItem.flock?.config" class="fld">
                  <label class="fld__label" :for="`variant-${flashItem.id}`">
                    {{ $t('choose_variant') }}
                  </label>
                  <v-select
                    :id="`variant-${flashItem.id}`"
                    :model-value="flashItem.flock.imageKey"
                    @update:model-value="(key) => flashStore.selectVariant(flashItem, key)"
                    :disabled="!flashItem.flock.config.board"
                    :items="variantImages(flashItem.flock.config.board)"
                    :item-title="variantTitle"
                    :item-value="imageKey"
                    :hint="variantHint(flashItem.flock.config.board)"
                    persistent-hint
                  ></v-select>
                </div>
              </div>

              <div
                v-if="
                  flashItem.flock?.config &&
                  installerFor(flashItem.flock.config.board, flashItem.flock.imageKey)
                "
                class="fld"
              >
                <span :id="`install-${flashItem.id}`" class="fld__label">
                  {{ $t('installation.method') }}
                </span>
                <div
                  class="radio-cards"
                  role="radiogroup"
                  :aria-labelledby="`install-${flashItem.id}`"
                >
                  <label
                    v-for="method in installMethods"
                    :key="method.value"
                    class="radio-card"
                    :class="{
                      'radio-card--on':
                        (flashItem.flock.installerKey !== undefined ? 'installer' : 'direct') ===
                        method.value
                    }"
                  >
                    <input
                      type="radio"
                      :name="`install-${flashItem.id}`"
                      :value="method.value"
                      :checked="
                        (flashItem.flock.installerKey !== undefined ? 'installer' : 'direct') ===
                        method.value
                      "
                      @change="
                        flashStore.selectInstallMethod(flashItem, method.value === 'installer')
                      "
                    />
                    <span>{{ method.title }}</span>
                  </label>
                </div>
              </div>

              <div v-if="flashItem.flock" class="form-grid form-grid--2">
                <div class="fld">
                  <label class="fld__label" :for="`ssid-${flashItem.id}`">
                    {{ $t('specify_wlan_or_lan') }}
                  </label>
                  <v-combobox
                    :id="`ssid-${flashItem.id}`"
                    v-model="flashItem.flock.config!.wlanssid"
                    item-title="ssid"
                    item-value="ssid"
                    :items="accessPoints"
                    :return-object="false"
                    hide-details
                  ></v-combobox>
                </div>

                <div class="fld">
                  <label class="fld__label" :for="`password-${flashItem.id}`">
                    {{ $t('wlan_password') }}
                  </label>
                  <v-text-field
                    :id="`password-${flashItem.id}`"
                    v-model="flashItem.flock.config!.password"
                    :append-inner-icon="flashItem.flock.showPassword ? 'mdi-eye' : 'mdi-eye-off'"
                    :type="flashItem.flock.showPassword ? 'text' : 'password'"
                    name="input-password"
                    hide-details
                    @click:append-inner="
                      flashItem.flock.showPassword = !flashItem.flock.showPassword
                    "
                  ></v-text-field>
                </div>
              </div>
            </div>

            <div v-else class="device__body">
              <FlashDisplay
                v-if="PROGRESS_STATES.includes(flashItem.flash.state)"
                :id="flashItem.id"
              />

              <div class="device__body-actions">
                <v-btn
                  v-if="flashItem.flash.state === 'flashing'"
                  class="btn-secondary"
                  variant="outlined"
                  prepend-icon="mdi-cancel"
                  @click="flashStore.cancelFlashing(flashItem)"
                >
                  {{ $t('cancel_writing') }}
                </v-btn>
                <v-btn
                  v-if="flashItem.flash.state === 'verifying'"
                  class="btn-secondary"
                  variant="outlined"
                  prepend-icon="mdi-skip-next"
                  @click="flashStore.cancelFlashing(flashItem)"
                >
                  {{ $t('skip_verification') }}
                </v-btn>

                <v-spacer></v-spacer>

                <v-btn
                  v-if="RETRY_STATES.includes(flashItem.flash.state)"
                  class="btn-secondary"
                  variant="outlined"
                  prepend-icon="mdi-refresh"
                  @click="flashStore.reset(flashItem)"
                >
                  {{ $t('try_again') }}
                </v-btn>
              </div>
            </div>
          </div>
        </v-expand-transition>
      </article>
    </div>
  </div>

  <Agent />
</template>
<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--v-layout-top, 64px) - var(--v-layout-bottom, 40px));
}

.page-head {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 12px;
  padding: 24px 32px 16px;
}

.page-head__row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.device-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 2px 24px 24px 32px;
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.device {
  flex: none;
}

.device__info {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr)) 40px;
  gap: 16px;
  align-items: start;
  padding: 16px 12px 0 24px;
}

.device__remove {
  grid-row: 1;
  grid-column: 5;
  margin-top: -4px;
}

.kv {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.kv__k {
  font: 500 12px/16px var(--font-sans);
  color: var(--ink-400);
}

.kv__v {
  overflow: hidden;
  font: 500 14px/20px var(--font-sans);
  color: var(--ink-900);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv__v--alert {
  color: var(--red-600);
}

.kv__s {
  overflow: hidden;
  font-size: 13px;
  line-height: 18px;
  color: var(--ink-500);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kv .chip {
  margin-top: 2px;
}

.device__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 24px;
}

.device__status {
  flex: 1;
  min-width: 0;
  padding: 0 12px;
}

.device__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 24px 24px;
  border-top: 1px solid var(--line-200);
}

.form-grid {
  display: grid;
  gap: 16px;
}

.form-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.form-grid--2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.device__body-actions {
  display: flex;
  gap: 8px;
}

.device__body-actions:empty {
  display: none;
}
</style>
