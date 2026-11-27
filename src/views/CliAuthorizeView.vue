<script setup lang="ts">
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'
import { authService } from '../services/authService'
import { errorMessage } from '../utils/errorMessage'

// Approves a `desk auth login` or `desk machine attach` from the CLI. The user types the code their terminal shows:
// it never travels in the link, so a link someone else sent can't be approved, as with
// GitHub's device login.
const authStore = useAuthStore()

const typedCode = ref('')
// The code as the server knows it, once the typed one matched a pending login.
const userCode = ref('')
const hostname = ref('')
// What the CLI asked for: its own login, or attaching the machine it runs on.
const purpose = ref<'login' | 'attach'>('login')
const state = ref<'enter' | 'checking' | 'ready' | 'busy' | 'approved' | 'denied' | 'error'>(
  'enter',
)
const error = ref('')

const handleFindLogin = async () => {
  const session = authStore.session
  if (!session || !typedCode.value.trim()) return
  error.value = ''
  state.value = 'checking'
  try {
    const result = await authService.getCliLogin(session, typedCode.value)
    userCode.value = result.args[0].user_code
    hostname.value = result.args[0].hostname
    purpose.value = result.args[0].purpose === 'attach' ? 'attach' : 'login'
    state.value = 'ready'
  } catch (e: unknown) {
    error.value = errorMessage(e)
    state.value = 'enter'
  }
}

const handleAnswer = async (approve: boolean) => {
  const session = authStore.session
  if (!session) return
  state.value = 'busy'
  try {
    if (approve) {
      await authService.approveCliLogin(session, userCode.value)
    } else {
      await authService.denyCliLogin(session, userCode.value)
    }
    state.value = approve ? 'approved' : 'denied'
  } catch (e: unknown) {
    error.value = errorMessage(e)
    state.value = 'error'
  }
}
</script>

<template>
  <div class="row justify-content-center align-items-center flex-grow-1 w-100 m-0 px-3 px-md-0">
    <div class="col-12 col-sm-10 col-md-6 col-lg-4">
      <div class="card shadow-lg border-0 fade-in-up">
        <div class="card-body p-4 p-md-5 text-center">
          <h3 class="card-title fw-bold mb-3">
            {{ state === 'enter' || purpose === 'login' ? 'Approve the CLI' : 'Attach a machine' }}
          </h3>

          <form v-if="state === 'enter' || state === 'checking'" @submit.prevent="handleFindLogin">
            <label for="cli-code" class="form-label">
              Enter the code <code>desk</code> shows in your terminal:
            </label>
            <input
              id="cli-code"
              v-model="typedCode"
              class="form-control form-control-lg text-center font-monospace mb-3"
              placeholder="XXXX-XXXX"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              maxlength="9"
              required
            />
            <div v-if="error" class="alert alert-danger d-flex align-items-center" role="alert">
              <span>{{ error }}</span>
            </div>
            <div class="d-grid">
              <button
                type="submit"
                class="btn btn-primary btn-lg"
                :disabled="!authStore.session || state === 'checking'"
              >
                {{
                  !authStore.session
                    ? 'Connecting…'
                    : state === 'checking'
                      ? 'Checking…'
                      : 'Continue'
                }}
              </button>
            </div>
          </form>

          <template v-else-if="state === 'ready' || state === 'busy'">
            <p v-if="purpose === 'attach'">
              A computer calling itself <strong>{{ hostname }}</strong> wants to attach itself to
              your account as a machine, with <code>desk machine attach</code>, using the code
              <strong class="font-monospace">{{ userCode }}</strong
              >.
            </p>
            <p v-else>
              A computer calling itself <strong>{{ hostname }}</strong> wants to sign in to your
              account with the <code>desk</code> CLI, using the code
              <strong class="font-monospace">{{ userCode }}</strong
              >.
            </p>
            <p v-if="purpose === 'attach'" class="text-muted small">
              Approving lets it add itself to your machines, so you can reach it remotely. Deny it
              if you didn't start this attach yourself.
            </p>
            <p v-else class="text-muted small">
              Approving gives it access to your account for a month. Deny it if you didn't start
              this login yourself.
            </p>
            <div class="d-grid gap-2 mt-4">
              <button
                class="btn btn-primary btn-lg"
                :disabled="!authStore.session || state === 'busy'"
                @click="handleAnswer(true)"
              >
                Approve
              </button>
              <button
                class="btn btn-outline-secondary"
                :disabled="!authStore.session || state === 'busy'"
                @click="handleAnswer(false)"
              >
                Deny
              </button>
            </div>
          </template>

          <p v-else-if="state === 'approved'">
            {{
              purpose === 'attach'
                ? `${hostname} is being attached.`
                : `The CLI on ${hostname} is signed in.`
            }}
            You can close this tab.
          </p>
          <p v-else-if="state === 'denied'">
            {{ purpose === 'attach' ? 'Attach' : 'Login' }} denied. You can close this tab.
          </p>
          <div v-else class="alert alert-danger d-flex align-items-center" role="alert">
            <span>{{ error }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
