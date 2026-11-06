<script setup lang="ts">
import { useSnackStore } from '@renderer/store/snack'
import { ref, watch } from 'vue'

const snackstore = useSnackStore()
const sudoPassword = ref('')
const showDialog = ref(false)
const showSudoPassword = ref(false)
const passwordSet = ref(false)
const checkingPassword = ref(false)
const resolve = ref()
const reject = ref()

async function setSudoPassword() {
  try {
    checkingPassword.value = true
    await window.api.setSudoPassword(sudoPassword.value)
    passwordSet.value = true
    showDialog.value = false
  } catch (error) {
    snackstore.setText('errors.invalid_sudo_password')
    snackstore.setColor('error')
    snackstore.setVisible(true)

    return // do nothing
  } finally {
    checkingPassword.value = false
  }

  return resolve.value()
}

async function openDialog() {
  const platform = await window.api.getPlatform()
  if (platform === 'win32') return true

  const isSudoPasswordSet = await window.api.isSudoPasswordSet()
  if (isSudoPasswordSet) {
    passwordSet.value = true
    return true
  }

  passwordSet.value = false
  showDialog.value = true

  return new Promise((res, rej) => {
    resolve.value = res
    reject.value = rej
  })
}

function closeDialog() {
  showDialog.value = false
}

defineExpose({
  openDialog,
  closeDialog
})

watch(showDialog, (newVal) => {
  if (newVal === false && !passwordSet.value) {
    reject.value(new Error('sudoPasswordNotSet'))
  }
})
</script>
<template>
  <v-dialog v-model="showDialog" max-width="480px">
    <v-card class="dlg">
      <div class="dlg__head">
        <span class="icon-tile sudo__tile">
          <v-icon size="20">mdi-shield-lock-outline</v-icon>
        </span>
        <h2 class="dlg__title">{{ $t('authentication_required') }}</h2>
        <v-btn
          class="btn-ghost"
          icon="mdi-close"
          size="small"
          variant="text"
          :aria-label="$t('close')"
          @click="closeDialog"
        ></v-btn>
      </div>

      <div class="dlg__body">
        <p class="t-body">{{ $t('authentication_explanation') }}</p>

        <div class="fld">
          <label class="fld__label" for="sudo-password">{{ $t('admin_password') }}</label>
          <v-text-field
            id="sudo-password"
            v-model="sudoPassword"
            autofocus
            :append-inner-icon="showSudoPassword ? 'mdi-eye' : 'mdi-eye-off'"
            :type="showSudoPassword ? 'text' : 'password'"
            name="input-sudoPasswd"
            :disabled="checkingPassword"
            hide-details
            @click:append-inner="showSudoPassword = !showSudoPassword"
            v-on:keyup.enter="setSudoPassword"
          ></v-text-field>
        </div>
      </div>

      <div class="dlg__foot">
        <v-btn
          color="primary"
          prepend-icon="mdi-lock-open-variant-outline"
          :loading="checkingPassword"
          @click="setSudoPassword"
        >
          {{ $t('submit') }}
        </v-btn>
      </div>
    </v-card>
  </v-dialog>
</template>
<style scoped>
.sudo__tile {
  background: var(--primary-100);
  color: var(--primary-600);
}
</style>
