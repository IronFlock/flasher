import { createApp } from 'vue'
import App from './App.vue'
import 'vuetify/styles'
import { createVuetify } from 'vuetify'
import { createPinia } from 'pinia'
import { en, de } from './locales'
import { createVueI18nAdapter } from 'vuetify/locale/adapters/vue-i18n'
import { createI18n, useI18n } from 'vue-i18n'
import * as components from 'vuetify/components'
import * as directives from 'vuetify/directives'

// Inter 400/500/600 is bundled (the CSP allows no font CDN, and the app must work offline).
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@mdi/font/css/materialdesignicons.css'
import './styles/tokens.css'
import './styles/app.css'

const i18n = createI18n({
  legacy: false, // Vuetify does not support the legacy mode of vue-i18n
  locale: 'en',
  globalInjection: true,
  fallbackLocale: 'de',
  messages: {
    en,
    de
  }
})

const vuetify = createVuetify({
  components,
  directives,
  locale: {
    adapter: createVueI18nAdapter({ i18n, useI18n })
  },
  // The IronFlock design tokens (styles/tokens.css) mapped onto Vuetify's theme
  // colours: one purple accent, purple-tinted neutrals, status colours at their
  // "600" (text-safe) step. The dark theme is derived from the same ramps.
  theme: {
    themes: {
      light: {
        dark: false,
        colors: {
          background: '#f8f7fb',
          surface: '#ffffff',
          'surface-light': '#e9e6f1',
          'surface-variant': '#241c3d',
          'on-background': '#1a1430',
          'on-surface': '#1a1430',
          'on-surface-variant': '#ffffff',
          primary: '#6446d6',
          'on-primary': '#ffffff',
          secondary: '#5e5778',
          accent: '#6446d6',
          error: '#b8322c',
          info: '#2b6fd6',
          success: '#1b7a50',
          warning: '#c2410c'
        },
        variables: {
          'border-color': '#1a1430',
          'border-opacity': 0.1,
          'high-emphasis-opacity': 1,
          'medium-emphasis-opacity': 0.68
        }
      },
      dark: {
        dark: true,
        colors: {
          background: '#15121f',
          surface: '#1d1930',
          'surface-light': '#332c50',
          'surface-variant': '#352c5c',
          'on-background': '#f3f1f8',
          'on-surface': '#f3f1f8',
          'on-surface-variant': '#ffffff',
          primary: '#7259e8',
          'on-primary': '#ffffff',
          secondary: '#bab3cf',
          accent: '#7259e8',
          error: '#f0817a',
          info: '#7aa9f2',
          success: '#4cc38a',
          warning: '#f59a5b'
        },
        variables: {
          'border-color': '#f3f1f8',
          'border-opacity': 0.12,
          'high-emphasis-opacity': 1,
          'medium-emphasis-opacity': 0.7
        }
      }
    }
  },
  defaults: {
    VBtn: { variant: 'flat' },
    VTextField: { variant: 'outlined', density: 'compact', color: 'primary' },
    VSelect: {
      variant: 'outlined',
      density: 'compact',
      color: 'primary',
      menuIcon: 'mdi-chevron-down'
    },
    VCombobox: {
      variant: 'outlined',
      density: 'compact',
      color: 'primary',
      menuIcon: 'mdi-chevron-down'
    },
    VTooltip: { location: 'bottom' }
  }
})

const app = createApp(App)
const pinia = createPinia()

app.use(i18n)
app.use(vuetify)
app.use(pinia)

app.mount('#app')
