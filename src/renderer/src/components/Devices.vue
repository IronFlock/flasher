<script setup lang="ts">
import Agent from './Agent.vue'
import type { ImageInfo, SupportedBoard } from 'src/types'
import { storeToRefs } from 'pinia'
import { useDrivesStore } from '@renderer/store/drives'
import { Drive } from 'drivelist'
import { computed, watch } from 'vue'
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
const { boards, flockos } = storeToRefs(boardStore)
const { t } = useI18n()

// Menu 1: the hardware only.
const boardTitle = (board: SupportedBoard) => hardwareTitle(board, boards.value)

// Menu 2: the variants of the chosen hardware, the FlockOS version once below.
const variantTitle = (image: ImageInfo) => {
  const variant = t(`variants.${image.variant}`)
  return image.kernel === 'rt' ? `${variant}, ${t('variants.rt')}` : variant
}

const variantHint = (board: SupportedBoard | undefined) => {
  if (!board) return t('choose_hardware_first')
  const version = defaultImage(board.latestImages)?.version
  return version ? `FlockOS ${version}` : ''
}

// Menu 3, only when the board's installer stick carries the chosen variant.
const installMethods = computed(() => [
  { value: 'direct', title: t('installation.direct') },
  { value: 'installer', title: t('installation.installer') }
])
const { accessPoints } = storeToRefs(wifiStore)
const { flashItems } = storeToRefs(flashStore)

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
  <v-container>
    <div class="header">
      <v-list-item>
        <v-list-item-title class="title">
          {{ $t('devices') }}
        </v-list-item-title>

        <v-list-item-subtitle>
          {{ $t('devices_list_subtitle') }}
        </v-list-item-subtitle>
      </v-list-item>
      <v-tooltip bottom>
        <template v-slot:activator="{ props }">
          <v-btn
            v-bind="props"
            @click="addByFilePicker"
            icon="mdi-plus"
            fixed
            elevation="10"
            color="accent"
            fab
          >
          </v-btn>
        </template>
        <span>{{ $t('add_device') }}</span>
      </v-tooltip>
    </div>

    <v-divider style="margin-top: 20px"></v-divider>

    <v-alert
      v-if="flockos && !flockos.ok"
      class="mt-2"
      type="error"
      density="compact"
      :title="
        flockos.kept
          ? $t('catalog.kept', { issuedAt: flockos.kept.issuedAt })
          : $t('catalog.refused')
      "
      :text="flockos.error"
    >
      <template #append>
        <v-btn size="small" variant="text" @click="boardStore.refresh(true)">
          {{ $t('catalog.retry') }}
        </v-btn>
      </template>
    </v-alert>
    <v-alert
      v-else-if="flockos?.ok && flockos.fromCache"
      class="mt-2"
      type="info"
      density="compact"
      :text="$t('catalog.offline', { issuedAt: flockos.issuedAt })"
    >
      <template #append>
        <v-btn size="small" variant="text" @click="boardStore.refresh(true)">
          {{ $t('catalog.retry') }}
        </v-btn>
      </template>
    </v-alert>

    <v-expansion-panels>
      <v-expansion-panel v-for="flashItem in flashItems">
        <!-- -------------------- Header of Device -------------------- -->

        <v-expansion-panel-title>
          <template v-slot>
            <div class="infobox-container">
              <div v-if="flashItem.reswarm" class="infoBox infoBoxA">
                <div class="textHead">
                  {{ $t('device') }}
                </div>
                <div class="textDesc deviceName">
                  {{
                    cutInfoString(flashItem.reswarm?.config?.name ?? '', 20, $t('no_device_name'))
                  }}
                </div>
                <div class="textMain">
                  {{ cutInfoString(flashItem.reswarm?.config?.description ?? '', 20, '') }}
                </div>
              </div>

              <div v-if="flashItem.reswarm" class="infoBox infoBoxA">
                <div class="textHead">
                  {{ $t('swarm') }}
                </div>
                <div class="textDesc">
                  {{
                    cutInfoString(
                      flashItem.reswarm?.config?.swarm_owner_name ?? '',
                      25,
                      $t('no_swarm_owner')
                    )
                  }}
                </div>
                <div class="textMain">
                  {{
                    cutInfoString(flashItem.reswarm?.config?.swarm_name ?? '', 25, $t('no_swarm'))
                  }}
                </div>
              </div>

              <div class="infoBox">
                <div class="textHead">
                  {{ $t('drive') }}
                </div>
                <div class="textDesc" v-bind:class="{ textAlert: !flashItem.drive }">
                  {{
                    flashItem.drive
                      ? cutInfoString(flashItem.drive.description, 25, $t('name_unknown'))
                      : $t('unavailable')
                  }}
                </div>
                <div class="textMain" v-bind:class="{ textAlert: !flashItem.drive }">
                  {{
                    flashItem.drive
                      ? cutInfoString(
                          flashItem.drive.device +
                            ' (' +
                            prettyBytes(flashItem.drive.size ?? 0) +
                            ')',
                          25
                        )
                      : $t('no_drive')
                  }}
                </div>
              </div>

              <div v-if="flashItem.reswarm" class="infoBox infoBoxA">
                <div class="textHead">
                  {{ $t('board') }}
                </div>
                <div
                  class="textDesc"
                  v-bind:class="{ textAlert: !flashItem.reswarm.config!.board }"
                >
                  {{
                    flashItem.reswarm.config!.board
                      ? cutInfoString(flashItem.reswarm.config!.board.architecture, 25)
                      : $t('board')
                  }}
                </div>
                <div
                  class="textMain"
                  v-bind:class="{ textAlert: !flashItem.reswarm.config!.board }"
                >
                  {{
                    flashItem.reswarm.config!.board
                      ? cutInfoString(flashItem.reswarm.config!.board.modelname, 25)
                      : $t('choose_board')
                  }}
                </div>
              </div>
            </div>

            <div class="buttons-container">
              <div class="editButtons" v-if="flashItem.flash.state === 'idle'">
                <v-btn size="small" height="40" color="primary" min-width="140px">
                  <v-icon> mdi-pencil </v-icon>
                  {{ $t('edit') }}
                </v-btn>
              </div>

              <div class="editButtons" v-if="flashItem.flash.state !== 'idle'">
                <v-btn size="small" height="40" color="primary" min-width="140px">
                  <v-icon> mdi-scatter-plot </v-icon>
                  {{ $t('details') }}
                </v-btn>
              </div>

              <div class="actionButtons">
                <v-btn
                  v-if="flashItem.reswarm && flashItem.flash.state === 'idle'"
                  :loading="downloadState === 'downloading'"
                  @click.native.stop="agentStore.testDevice(flashItem)"
                  style="margin-right: 16px"
                  size="small"
                  height="40"
                  color="primary"
                >
                  <v-icon> mdi-play </v-icon>
                  {{ $t('test_device') }}
                </v-btn>

                <v-btn
                  size="small"
                  :disabled="
                    flashItem.flash.state === 'flashing' ||
                    flashItem.flash.state === 'downloading' ||
                    flashItem.flash.state === 'configuring' ||
                    flashItem.flash.state === 'verifying' ||
                    flashItem.flash.state === 'starting' ||
                    flashItem.flash.state === 'decompressing' ||
                    !flashItem.drive
                  "
                  @click.native.stop="flashStore.flashDevice(flashItem)"
                  height="40"
                  min-width="140px"
                  color="primary"
                >
                  <v-icon> mdi-flash </v-icon>
                  {{ $t('flash') }}
                </v-btn>
              </div>
            </div>

            <div>
              <div id="removeButton">
                <v-btn
                  :disabled="
                    flashItem.flash.state !== 'idle' &&
                    flashItem.flash.state !== 'finished' &&
                    flashItem.flash.state !== 'failed' &&
                    flashItem.flash.state !== 'verification-canceled' &&
                    flashItem.flash.state !== 'flashing-canceled'
                  "
                  @click.native.stop="flashStore.removeItem(flashItem)"
                  variant="plain"
                  icon="mdi-close-circle"
                  color="error"
                >
                </v-btn>
              </div>
            </div>

            <!-- -------------------- Header of Device (flashing active) -------------------- -->

            <div id="flashDeviceBar">
              <FlashDevice v-if="flashItem.flash.state !== 'idle'" :id="flashItem.id" />
            </div>
          </template>
        </v-expansion-panel-title>

        <!-- -------------------- Body of Device (inactive) -------------------- -->

        <v-expansion-panel-text>
          <div style="margin-top: 16px">
            <v-select
              v-if="flashItem.flash.state === 'idle'"
              v-model="flashItem.drive"
              :items="drives"
              :label="$t('select_drive')"
              :item-title="(el: Drive) => `${el.device} - (${prettyBytes(el.size ?? 0)})`"
              :item-value="(el) => el"
              :no-data-text="$t('no_drives_available')"
              variant="outlined"
            ></v-select>

            <v-select
              v-if="flashItem.reswarm && flashItem.flash.state === 'idle'"
              :model-value="flashItem.reswarm.config!.board"
              @update:model-value="(board) => flashStore.selectBoard(flashItem, board)"
              @update:menu="(open: boolean) => open && boardStore.refresh()"
              :label="$t('choose_hardware')"
              :items="boards"
              :item-title="boardTitle"
              :item-value="(el) => el"
              variant="outlined"
            ></v-select>

            <v-select
              v-if="flashItem.reswarm?.config && flashItem.flash.state === 'idle'"
              :model-value="flashItem.reswarm.imageKey"
              @update:model-value="(key) => flashStore.selectVariant(flashItem, key)"
              :label="$t('choose_variant')"
              :disabled="!flashItem.reswarm.config.board"
              :items="variantImages(flashItem.reswarm.config.board)"
              :item-title="variantTitle"
              :item-value="imageKey"
              :hint="variantHint(flashItem.reswarm.config.board)"
              persistent-hint
              variant="outlined"
              class="mb-4"
            ></v-select>

            <v-select
              v-if="
                flashItem.reswarm?.config &&
                flashItem.flash.state === 'idle' &&
                installerFor(flashItem.reswarm.config.board, flashItem.reswarm.imageKey)
              "
              :model-value="flashItem.reswarm.installerKey !== undefined ? 'installer' : 'direct'"
              @update:model-value="
                (method) => flashStore.selectInstallMethod(flashItem, method === 'installer')
              "
              :label="$t('installation.method')"
              :items="installMethods"
              variant="outlined"
            ></v-select>

            <v-combobox
              v-if="flashItem.reswarm && flashItem.flash.state === 'idle'"
              v-model="flashItem.reswarm.config!.wlanssid"
              :label="$t('specify_wlan_or_lan')"
              item-title="ssid"
              item-value="ssid"
              :items="accessPoints"
              variant="outlined"
              :return-object="false"
            ></v-combobox>

            <v-text-field
              v-if="flashItem.reswarm && flashItem.flash.state === 'idle'"
              v-model="flashItem.reswarm.config!.password"
              :label="$t('wlan_password')"
              :append-icon="flashItem.reswarm.showPassword ? 'mdi-eye' : 'mdi-eye-off'"
              :type="flashItem.reswarm.showPassword ? 'text' : 'password'"
              name="input-password"
              variant="outlined"
              @click:append="flashItem.reswarm.showPassword = !flashItem.reswarm.showPassword"
            ></v-text-field>
          </div>

          <!-- -------------------- Body of Device (flashing active) -------------------- -->

          <div v-show="flashItem.flash.state !== 'idle'">
            <FlashDisplay
              v-if="
                flashItem.flash.state === 'decompressing' ||
                flashItem.flash.state === 'flashing' ||
                flashItem.flash.state === 'verifying' ||
                flashItem.flash.state === 'downloading'
              "
              :id="flashItem.id"
            >
            </FlashDisplay>

            <div class="d-flex justify-center">
              <v-btn
                v-if="flashItem.flash.state === 'flashing'"
                small
                color="secondary"
                height="40"
                @click.native.stop="flashStore.cancelFlashing(flashItem)"
              >
                <v-icon left> mdi-cancel </v-icon>
                {{ $t('cancel_writing') }}
              </v-btn>
              <v-btn
                v-if="flashItem.flash.state === 'verifying'"
                small
                color="secondary"
                height="40"
                @click.native.stop="flashStore.cancelFlashing(flashItem)"
              >
                <v-icon left> mdi-skip-next </v-icon>
                {{ $t('skip_verification') }}
              </v-btn>

              <v-spacer></v-spacer>

              <v-btn
                ref="button"
                size="small"
                color="secondary"
                height="40"
                @click="flashStore.reset(flashItem)"
                v-if="
                  flashItem.flash.state === 'finished' ||
                  flashItem.flash.state === 'failed' ||
                  flashItem.flash.state === 'flashing-canceled' ||
                  flashItem.flash.state === 'verification-canceled'
                "
              >
                <v-icon left> mdi-refresh </v-icon>
                {{ $t('try_again') }}
              </v-btn>
            </div>
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>
  </v-container>

  <Agent />
</template>
<style>
.v-expansion-panel-title {
  cursor: unset !important;
  pointer-events: none;
}

.v-btn--disabled {
  pointer-events: none !important;
}

.v-expansion-panel .v-btn {
  pointer-events: auto;
}

.v-expansion-panel-title__overlay {
  display: none !important;
}

.v-expansion-panels {
  padding: 2px !important;
}

.v-expansion-panel-title {
  display: block !important;
}

.v-expansion-panel-title__icon {
  display: none !important;
}

.buttons-container {
  display: flex;
  justify-content: space-between;
  margin-top: 16px;
}

.infobox-container {
  display: flex;
}

.v-expansion-panels {
  max-height: 325px;
  overflow: auto;
}
.header {
  display: flex;
  justify-content: space-between;
}

.mdi-plus {
  color: white;
}

#device-list {
  position: relative;
  max-height: 80px;
  overflow: visible;
}

#flash-button-wrapper {
  position: fixed;
  bottom: 42px;
  left: 0px;
  z-index: 4;
  width: 100%;
}

#auth-footnote {
  font-size: 70%;
}

#flashButton {
  padding-left: 80px;
  margin-top: 13px;
  margin-bottom: 13px;
  width: 160px;
  max-width: 160px;
  display: inline-block;
  /* position: absolute;
  bottom: 33px;
  right: 68px; */
}

#removeButton {
  position: absolute;
  top: 4px;
  right: 0;
}

#transparentButton {
  background-color: transparent;
}

#flashDeviceBar {
  /* margin: 0px;
  padding-bottom: 2px; */
  position: absolute;
  bottom: 4px;
  left: 160px;
  right: 160px;
  /* width: 710px; */
  /* align-content: center; */
  /* width: 100%; */
}

.textHead {
  /* font-size: 12px; */
  font-weight: 500;
  padding-bottom: 2px;
}

.textDesc {
  /* font-size: 12px; */
  line-height: 1.5;
}

.textMain {
  padding-top: 1px;
}

.textAlert {
  color: #e62828;
}

.infoBox {
  padding: 4px;
  margin: 1px;
  border-style: none;
  border-width: 3px;
  border-radius: 5px;
}

.infoBoxAlert {
  border-style: dashed;
  border-color: #e62828;
  border-width: 2px;
  border-radius: 0px;
}

.infoBoxA {
  width: 190px;
  max-width: 190px;
  display: inline-block;
}

.fade-enter-active,
.fade-leave-active {
  transition: all 0.3s;
}
.fade-enter, .fade-leave-to /* .fade-leave-active below version 2.1.8 */ {
  opacity: 0;
  transform: translateY(50px);
}

.bar-prog {
  pointer-events: none;
}
</style>
