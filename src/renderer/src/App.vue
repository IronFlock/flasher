<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTheme } from 'vuetify'

// ?no-inline: a small SVG would become a data: URI, which the CSP (img-src 'self') blocks.
import logoOnLight from './assets/ironflock-logo.svg?no-inline'
import logoOnDark from './assets/icon.png'

import Settings from './components/Settings.vue'
import Drives from './components/Drives.vue'
import Devices from './components/Devices.vue'
import SudoDialog from './components/SudoDialog.vue'
import Snackbar from './components/Snackbar.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import AgentDownloadProgress from './components/AgentDownloadProgress.vue'

const theme = useTheme()
const sudoDialog = ref()
const drivesDrawer = ref(false)
const settingsDrawer = ref(false)

// The colour bird on the white header; the white bird on the dark one.
const logo = computed(() => (theme.global.current.value.dark ? logoOnDark : logoOnLight))

function toggleDrivesDrawer() {
  drivesDrawer.value = !drivesDrawer.value
}

function toggleSettingsDrawer() {
  settingsDrawer.value = !settingsDrawer.value
}

watch(sudoDialog, (newVal) => {
  window.sudoDialog = newVal
})
</script>

<template>
  <v-app>
    <!-- -------------------- Drives -------------------- -->

    <v-navigation-drawer v-model="drivesDrawer" temporary width="380">
      <Drives />
    </v-navigation-drawer>

    <!-- -------------------- Settings -------------------- -->

    <v-navigation-drawer v-model="settingsDrawer" temporary location="right" width="380">
      <Settings />
    </v-navigation-drawer>

    <!-- -------------------- Header -------------------- -->

    <v-app-bar class="app-header" flat height="64">
      <div class="app-header__inner">
        <v-btn
          class="btn-secondary"
          variant="outlined"
          prepend-icon="mdi-usb-flash-drive-outline"
          @click.stop="toggleDrivesDrawer"
        >
          {{ $t('drives') }}
        </v-btn>

        <div class="brand">
          <img :src="logo" alt="" width="28" height="28" />
          <span class="brand__name">FlockFlasher</span>
        </div>

        <v-btn
          class="btn-secondary"
          variant="outlined"
          prepend-icon="mdi-cog-outline"
          @click.stop="toggleSettingsDrawer"
        >
          {{ $t('settings') }}
        </v-btn>
      </div>
    </v-app-bar>

    <!-- -------------------- Devices -------------------- -->

    <v-main>
      <Devices />
    </v-main>

    <!-- -------------------- Footer -------------------- -->

    <v-footer app class="app-footer" height="40">
      <a href="https://studio.ironflock.com/" target="_blank" class="app-footer__link">
        IronFlock Platform
      </a>
    </v-footer>

    <SudoDialog ref="sudoDialog" />
    <Snackbar />
    <UpdateBanner />
    <AgentDownloadProgress />
  </v-app>
</template>

<style>
/* Header (spec §2.3): white, 64px, hairline below, no dark surface. */
.v-app-bar.app-header {
  background: var(--surface-0);
  border-bottom: 1px solid var(--line-200);
  color: var(--ink-900);
}

.app-header__inner {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  width: 100%;
  padding: 0 32px;
}

.app-header__inner > :first-child {
  justify-self: start;
}

.app-header__inner > :last-child {
  justify-self: end;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand__name {
  font: 600 16px/24px var(--font-sans);
  color: var(--ink-900);
}

/* Footer: a quiet hairline bar with one link. */
.v-footer.app-footer {
  justify-content: center;
  padding: 0;
  border-top: 1px solid var(--line-200);
  background: var(--surface-0);
}

.app-footer__link {
  font: 500 13px/18px var(--font-sans);
  color: var(--ink-500);
}

.app-footer__link:hover {
  color: var(--primary-600);
}
</style>
