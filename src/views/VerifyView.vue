<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import VOtpInput from 'vue3-otp-input'
import { useAuthStore } from '../stores/auth'
import { errorMessage } from '../utils/errorMessage'

const router = useRouter()
const authStore = useAuthStore()

const otpInput = ref<InstanceType<typeof VOtpInput> | null>(null)
const error = ref('')
const resendSuccess = ref(false)
const isLoading = ref(false)

// Timer State
const timeLeft = ref(60)
const timerInterval = ref<number | null>(null)

const canResend = computed(() => {
  // Enabled if 30 seconds have passed (i.e. timeLeft <= 30)
  return timeLeft.value <= 30
})

const isLoginFlow = computed(() => !authStore.pendingUsername && !!authStore.pendingLoginUsername)
const displayUsername = computed(() => authStore.pendingUsername || authStore.pendingLoginUsername)

const startTimer = () => {
  // Clear existing if any
  if (timerInterval.value) clearInterval(timerInterval.value)

  // Check storage for start time
  const startTimeStr = localStorage.getItem('verify_otp_start')
  let startTime: number

  if (startTimeStr) {
    startTime = parseInt(startTimeStr, 10)
  } else {
    startTime = Date.now()
    localStorage.setItem('verify_otp_start', startTime.toString())
  }

  const updateTimer = () => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000)
    const remaining = 60 - elapsed

    if (remaining <= 0) {
      timeLeft.value = 0
      if (timerInterval.value) clearInterval(timerInterval.value)
    } else {
      timeLeft.value = remaining
    }
  }

  updateTimer() // run immediately
  timerInterval.value = window.setInterval(updateTimer, 1000)
}

onMounted(() => {
  if (!authStore.pendingUsername && !authStore.pendingLoginUsername) {
    // No pending verification, redirect to login
    router.replace('/login')
    return
  }
  startTimer()
})

onUnmounted(() => {
  if (timerInterval.value) clearInterval(timerInterval.value)
})

const handleResend = async () => {
  if (!canResend.value) return

  isLoading.value = true
  error.value = ''
  resendSuccess.value = false
  try {
    await authStore.resendOtp()
    // Reset Timer
    localStorage.removeItem('verify_otp_start')
    startTimer()

    resendSuccess.value = true
    setTimeout(() => {
      resendSuccess.value = false
    }, 3000)
  } catch (e: unknown) {
    console.error(e)
    error.value = 'Resend failed: ' + errorMessage(e)
  } finally {
    isLoading.value = false
  }
}

const handleOnComplete = async (value: string) => {
  error.value = ''
  isLoading.value = true
  try {
    if (isLoginFlow.value) {
      await authStore.verifyLoginOtp(value)
      router.push('/')
    } else {
      await authStore.verifyAccount(value)
      router.push('/')
    }
  } catch (e: unknown) {
    console.error(e)
    error.value = 'Verification failed: ' + errorMessage(e)
    // clear input on error
    otpInput.value?.clearInput()
  } finally {
    isLoading.value = false
  }
}

const handleOnChange = () => {
  // value unused
}
</script>

<template>
  <div class="row justify-content-center align-items-center flex-grow-1 w-100 m-0 px-3 px-md-0">
    <div class="col-12 col-sm-10 col-md-6 col-lg-4">
      <div class="card shadow-lg border-0 fade-in-up">
        <div class="card-body p-4 p-md-5 text-center">
          <h3 class="card-title fw-bold mb-3">Verify Your Account</h3>
          <p class="text-muted mb-4">
            Enter the 6-digit code sent to your email/device for user
            <strong class="text-dark">{{ displayUsername }}</strong>
          </p>

          <div
            v-if="error"
            class="alert alert-danger d-flex align-items-center justify-content-center"
            role="alert"
          >
            <span class="text-break">{{ error }}</span>
          </div>

          <div class="d-flex justify-content-center mb-4">
            <v-otp-input
              ref="otpInput"
              input-classes="otp-input form-control text-center mx-1 fw-bold"
              separator=""
              :num-inputs="6"
              :should-auto-focus="true"
              :is-input-num="true"
              :conditionalClass="['one', 'two', 'three', 'four', 'five', 'six']"
              @on-change="handleOnChange"
              @on-complete="handleOnComplete"
            />
          </div>

          <div v-if="isLoading" class="spinner-border text-primary mb-3" role="status">
            <span class="visually-hidden">Verifying...</span>
          </div>

          <div class="mt-3">
            <small v-if="!isLoginFlow" class="text-muted d-block mb-2">
              Didn't receive the code?
              <a
                href="#"
                @click.prevent="handleResend"
                class="fw-bold"
                :class="{ 'disabled text-muted': !canResend, 'text-primary': canResend }"
                :style="{ pointerEvents: !canResend ? 'none' : 'auto' }"
              >
                Resend Code
              </a>
              <span v-if="timeLeft > 0" class="ms-1">({{ timeLeft }}s)</span>
              <span v-if="resendSuccess" class="text-success ms-2 fw-bold">Sent!</span>
            </small>

            <small class="text-muted">
              <template v-if="isLoginFlow">
                Wrong account?
                <a href="#" @click.prevent="router.replace('/login')" class="fw-bold">Back to login</a>
              </template>
              <template v-else>
                Wrong username?
                <a href="#" @click.prevent="router.replace('/register')" class="fw-bold"
                  >Register again</a
                >
              </template>
            </small>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(.otp-input) {
  box-sizing: border-box;
  width: 50px;
  height: 60px;
  padding: 0;
  margin: 0 4px; /* Slightly reduced margin to fit 6 inputs in col-lg-4 */
  font-size: 1.5rem;
  line-height: 60px;
  font-weight: 700;
  border-radius: 8px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  text-align: center;
  background-color: #fff;
  transition: all 0.2s ease;
}

/* 6 boxes at desktop size (50px + 8px margin each) overflow narrow phone
   screens, pushing/clipping later digits out of view. Shrink to fit. */
@media (max-width: 575.98px) {
  :deep(.otp-input) {
    width: 32px;
    height: 44px;
    margin: 0 2px;
    font-size: 1.1rem;
    line-height: 44px;
  }
}
/* Focus style handled by bootstrap form-control mostly, but we can enhance */
:deep(.otp-input:focus) {
  border-color: var(--bs-primary);
  box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.08);
  transform: translateY(-2px);
  outline: 0;
}
</style>
