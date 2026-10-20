<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { Modal } from 'bootstrap'
import { useAuthStore } from '../stores/auth'
import { errorMessage } from '../utils/errorMessage'
import { STANDALONE_REALM } from '../config'

const router = useRouter()
const authStore = useAuthStore()
const loginSuccessModal = ref<HTMLElement | null>(null)
let modalInstance: Modal | null = null

// Form State
const form = ref({
  email: '',
  password: '',
})

const error = ref('')
const showPassword = ref(false)

// Standalone: log in directly to one machine running `deskconnd --standalone`.
const standaloneMode = ref(false)
const standaloneForm = ref({
  url: '',
  authId: '',
  method: 'password' as 'password' | 'key',
  secret: '',
})
const connecting = ref(false)
const STANDALONE_KEY_AUTHID = 'deskconn-web-app'

function toggleMode() {
  standaloneMode.value = !standaloneMode.value
  error.value = ''
}

const handleStandaloneLogin = async () => {
  const f = standaloneForm.value
  error.value = ''
  connecting.value = true
  try {
    await authStore.loginStandalone({
      url: f.url.trim(),
      // deskconnd accepts any authid with a --public-key, so key logins don't ask for one.
      ...(f.method === 'key'
        ? { authId: STANDALONE_KEY_AUTHID, privateKey: f.secret.trim() }
        : { authId: f.authId.trim(), password: f.secret }),
    })
    router.replace({ name: 'desktop-launcher', params: { realm: STANDALONE_REALM } })
  } catch (e: unknown) {
    console.error(e)
    error.value = 'Connection failed: ' + errorMessage(e)
  } finally {
    connecting.value = false
  }
}

const validateEmail = (email: string) => {
  return String(email)
    .toLowerCase()
    .match(
      /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
    )
}

onMounted(() => {
  if (loginSuccessModal.value) {
    modalInstance = new Modal(loginSuccessModal.value)
    loginSuccessModal.value.addEventListener('hidden.bs.modal', () => {
      if (authStore.isAuthenticated) {
        router.push('/')
      }
    })
  }
})

const handleLogin = async () => {
  try {
    error.value = ''

    if (!form.value.email || !validateEmail(form.value.email)) {
      error.value = 'Please enter a valid email address.'
      return
    }

    if (!form.value.password) {
      error.value = 'Password is required.'
      return
    }

    // Call store action - sends the OTP, actual login completes on the verify page
    await authStore.login(form.value.email, form.value.password)

    // replace (not push): drop the login entry so back never resurfaces the OTP step
    router.replace('/verify')
  } catch (e: unknown) {
    console.error(e)
    error.value = 'Login failed: ' + errorMessage(e)
  }
}

const handleSuccessConfirm = () => {
  modalInstance?.hide()
  router.push('/')
}
</script>

<template>
  <div class="row justify-content-center align-items-center flex-grow-1 w-100 m-0 px-3 px-md-0">
    <div class="col-12 col-sm-10 col-md-6 col-lg-4">
      <div class="card shadow-lg border-0 fade-in-up">
        <div class="card-body p-4 p-md-5">
          <div class="text-center mb-5">
            <h3 class="card-title fw-bold">{{ standaloneMode ? 'Standalone Machine' : 'Welcome Back' }}</h3>
            <p class="text-muted text-sm">
              {{ standaloneMode ? 'Connect directly to a machine, no account needed' : 'Login to your account' }}
            </p>
          </div>

          <div v-if="error" class="alert alert-danger d-flex align-items-center" role="alert">
            <span>{{ error }}</span>
          </div>

          <form v-if="standaloneMode" @submit.prevent="handleStandaloneLogin">
            <div class="mb-3">
              <label for="sa-url" class="form-label">Machine URL</label>
              <input
                type="text"
                class="form-control form-control-lg"
                id="sa-url"
                v-model="standaloneForm.url"
                required
                placeholder="https://desk.example.com:18081"
              />
            </div>
            <div class="btn-group w-100 mb-3" role="group" aria-label="Authentication method">
              <input type="radio" class="btn-check" id="sa-method-password" value="password" v-model="standaloneForm.method" />
              <label class="btn btn-outline-secondary btn-sm" for="sa-method-password">Password</label>
              <input type="radio" class="btn-check" id="sa-method-key" value="key" v-model="standaloneForm.method" />
              <label class="btn btn-outline-secondary btn-sm" for="sa-method-key">Private key</label>
            </div>
            <div v-if="standaloneForm.method === 'password'" class="mb-3">
              <label for="sa-authid" class="form-label">Username</label>
              <input
                type="text"
                class="form-control form-control-lg"
                id="sa-authid"
                v-model="standaloneForm.authId"
                required
                autocomplete="username"
              />
            </div>
            <div class="mb-3">
              <label for="sa-secret" class="form-label">
                {{ standaloneForm.method === 'key' ? 'Private key' : 'Password' }}
              </label>
              <div class="input-group-theme">
                <input
                  :type="showPassword ? 'text' : 'password'"
                  class="form-control form-control-lg pe-5"
                  id="sa-secret"
                  v-model="standaloneForm.secret"
                  required
                  :placeholder="standaloneForm.method === 'key' ? 'hex private key' : '••••••••'"
                  :autocomplete="standaloneForm.method === 'key' ? 'off' : 'current-password'"
                />
                <button
                  type="button"
                  class="btn btn-password-toggle"
                  @click="showPassword = !showPassword"
                  tabindex="-1"
                >
                  <i class="bi" :class="showPassword ? 'bi-eye-slash' : 'bi-eye'"></i>
                </button>
              </div>
            </div>

            <div class="d-grid gap-2 mt-4">
              <button type="submit" class="btn btn-primary btn-lg" :disabled="connecting">
                {{ connecting ? 'Connecting…' : 'Connect' }}
              </button>
            </div>
            <div class="text-center mt-4">
              <a href="#" class="fw-bold" @click.prevent="toggleMode">Log in with an account instead</a>
            </div>
          </form>

          <form v-else @submit.prevent="handleLogin">
            <div class="mb-4">
              <label for="email" class="form-label">Email</label>
              <input
                type="email"
                class="form-control form-control-lg"
                id="email"
                v-model="form.email"
                required
                placeholder="name@example.com"
                autocomplete="email"
              />
            </div>
            <div class="mb-4">
              <label for="password" class="form-label">Password</label>
              <div class="input-group-theme">
                <input
                  :type="showPassword ? 'text' : 'password'"
                  class="form-control form-control-lg pe-5"
                  id="password"
                  v-model="form.password"
                  required
                  placeholder="••••••••"
                  autocomplete="current-password"
                />
                <button
                  type="button"
                  class="btn btn-password-toggle"
                  @click="showPassword = !showPassword"
                  tabindex="-1"
                >
                  <i class="bi" :class="showPassword ? 'bi-eye-slash' : 'bi-eye'"></i>
                </button>
              </div>
            </div>

            <div class="d-grid gap-2 mt-4">
              <button type="submit" class="btn btn-primary btn-lg">Login</button>
            </div>
            <div class="text-center mt-3">
              <router-link
                to="/forgot-password"
                class="text-primary text-decoration-none small fw-bold"
                >Forgot password?</router-link
              >
            </div>
            <div class="text-center mt-4">
              <span class="text-muted">Don't have an account? </span>
              <router-link to="/register" class="fw-bold">Sign up</router-link>
            </div>
            <div class="text-center mt-2">
              <a href="#" class="small fw-bold" @click.prevent="toggleMode">Connect to a standalone machine</a>
            </div>

          </form>
        </div>
      </div>
    </div>
  </div>

  <!-- Success Modal (Kept if needed, but unused in favored flow) -->
  <div
    class="modal fade"
    id="successModal"
    tabindex="-1"
    ref="loginSuccessModal"
    aria-hidden="true"
  >
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header bg-success text-white">
          <h5 class="modal-title">Success</h5>
          <button
            type="button"
            class="btn-close"
            data-bs-dismiss="modal"
            aria-label="Close"
          ></button>
        </div>
        <div class="modal-body">Login Successful!</div>
        <div class="modal-footer">
          <button type="button" class="btn btn-primary" @click="handleSuccessConfirm">Okay</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.input-group-theme {
  position: relative;
  display: flex;
  align-items: center;
}

.btn-password-toggle {
  position: absolute;
  right: 12px;
  background: none;
  border: none;
  color: #64748b;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s ease;
  z-index: 5;
}

.btn-password-toggle:hover {
  color: var(--theme-blue);
}
</style>
