<script setup lang="ts">
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTheme } from 'vuetify/lib/framework.mjs'
import { useLocalStorage } from 'vue-composable'
import { ref } from 'vue'
import { langLocaleMap } from '@renderer/locales'

const i18nLocale = useI18n()
const theme = useTheme()

const availableLanguages = ref(['English', 'Deutsch'])

const { storage: darkMode } = useLocalStorage('darkMode', false, true)
const { storage: language } = useLocalStorage('language', 'English', true)

i18nLocale.locale.value = langLocaleMap[language.value]
watch(
  darkMode,
  (newVal) => {
    theme.global.name.value = newVal ? 'dark' : 'light'
  },
  { immediate: true }
)

watch(language, (newVal) => {
  i18nLocale.locale.value = langLocaleMap[newVal]
})
</script>

<template>
  <div class="drawer">
    <div class="panel-head">
      <div>
        <h2 class="t-heading">{{ $t('settings') }}</h2>
        <p class="t-meta">{{ $t('settings_subtitle') }}</p>
      </div>
    </div>

    <div class="list-card">
      <div class="row">
        <label class="row__text row__title" for="settings-language">
          {{ $t('choose_language') }}
        </label>
        <v-select
          id="settings-language"
          v-model="language"
          class="settings__select"
          :items="availableLanguages"
          hide-details
        ></v-select>
      </div>
      <div class="row">
        <label class="row__text row__title" for="settings-dark-mode">
          {{ $t('dark_mode') }}
        </label>
        <v-switch
          id="settings-dark-mode"
          v-model="darkMode"
          color="success"
          density="compact"
          inset
          hide-details
        ></v-switch>
      </div>
    </div>
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

.settings__select {
  flex: none;
  width: 148px;
}

.row .v-switch {
  flex: none;
}
</style>
