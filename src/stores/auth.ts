import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { CryptoSignAuthenticator } from 'xconn'
import {
  wampService,
  normalizeStandaloneURL,
  standaloneAuthenticator,
  type StandaloneCreds,
  type WampSession,
} from '../services/wamp'
import { STANDALONE_REALM } from '../config'
import { authService } from '../services/authService'
import { SecureStorage } from '../services/storageService'
import { generateDeviceID, generateKeys } from '../utils/crypto'
import { type User } from '../types'
import { useSessionCacheStore } from './sessionCache'
import { useSettingsStore } from './settings'

const STANDALONE_CREDS_KEY = 'standalone_credentials'

export const useAuthStore = defineStore('auth', () => {
  // State

  const user = ref<User | null>(JSON.parse(localStorage.getItem('currentUser') || 'null'))
  const session = ref<WampSession | null>(null)
  const pendingUsername = ref<string | null>(localStorage.getItem('pending_verification_user'))
  const pendingLoginUsername = ref<string | null>(null)
  const pendingLoginPassword = ref<string | null>(null)
  // Set while logged in to a standalone machine (no cloud account, no `session`).
  const standalone = ref<StandaloneCreds | null>(null)

  // Getters
  const isAuthenticated = computed(() => !!user.value)

  // Helper: Persist user state
  function setUser(userData: User | null) {
    user.value = userData
    if (userData) {
      localStorage.setItem('currentUser', JSON.stringify(userData))
    } else {
      localStorage.removeItem('currentUser')
    }
  }

  // Actions
  async function register(form: { username: string; name: string; password: string }) {
    try {
      const { result, session: s } = await authService.register(form)
      console.dir(result)

      // Store session and username for verification step
      session.value = s
      pendingUsername.value = form.username
      localStorage.setItem('pending_verification_user', form.username)

      // A stale login-OTP flow must not shadow this new pending verification
      pendingLoginUsername.value = null
      pendingLoginPassword.value = null

      return result
    } catch (err) {
      session.value = null
      throw err
    }
  }

  async function verifyAccount(code: string) {
    const username = pendingUsername.value
    if (!username) {
      throw new Error('No pending registration found.')
    }

    let s = session.value
    let createdNewSession = false
    if (!s) {
      console.log('Restoring registrar session for verification...')
      s = await authService.getRegistrarSession()
      createdNewSession = true
    }

    // Principal keypair — same account-level identity used at login (see
    // verifyLoginOtp), so verification can log the user straight in.
    const { privateKey: principalPrivateKey, publicKey: principalPublicKey } = await generateKeys()

    let verifyResult
    try {
      verifyResult = await authService.verifyAccount(s, username, code, principalPublicKey)
      console.dir(verifyResult)
    } finally {
      await s.leave().catch(console.error)
      if (session.value === s || createdNewSession) {
        session.value = null
      }
    }

    pendingUsername.value = null
    localStorage.removeItem('pending_verification_user')

    const principalExpiresAt = verifyResult?.args?.[0]?.expires_at

    // Verified — the freshly-registered principal key logs the user in
    // immediately, no separate login step required.
    const { session: authSession, result } = await authService.autoLogin(username, principalPrivateKey)
    session.value = authSession

    const userDetails = result.args[0]
    if (!userDetails || !userDetails.id) {
      await authSession.leave()
      throw new Error('Invalid user details received')
    }

    await completeAuthSession(
      authSession,
      userDetails,
      principalPrivateKey,
      principalPublicKey,
      principalExpiresAt,
    )

    return verifyResult
  }

  async function resendOtp() {
    const username = pendingUsername.value
    if (!username) {
      throw new Error('No pending registration found.')
    }

    try {
      const { result, session: s } = await authService.resendOtp(session.value, username)
      console.dir(result)

      // Update session if it was restored/created
      if (!session.value) {
        session.value = s
      }
      return result
    } catch (err) {
      throw err
    }
  }

  async function forgotPassword(email: string) {
    try {
      const { result, session: s, error } = await authService.forgotPassword(email)
      if (error) throw error

      session.value = s
      return result
    } catch (err) {
      session.value = null
      throw err
    }
  }

  async function resetPassword(email: string, password: string, otp: string) {
    const s = session.value
    try {
      const { result, session: newSession } = await authService.resetPassword(
        s,
        email,
        password,
        otp,
      )

      if (newSession) {
        await newSession.leave().catch(console.error)
      }
      session.value = null
      return result
    } catch (err) {
      throw err
    }
  }

  async function login(username: string, password: string) {
    // Password checked server-side; on success an OTP is emailed and login
    // completes in verifyLoginOtp once the code is confirmed.
    const { session: s } = await authService.requestLoginOtp(username, password)
    await s.leave().catch(console.error)

    pendingLoginUsername.value = username
    pendingLoginPassword.value = password

    // A stale registration-verify flow must not shadow this new pending login
    pendingUsername.value = null
    localStorage.removeItem('pending_verification_user')
  }

  // Persists the principal keypair, registers a device credential if this
  // browser doesn't have one yet, and marks the user as logged in. Shared by
  // login and registration verification, since both end the same way: a
  // freshly-verified principal key and an authenticated session.
  async function completeAuthSession(
    s: WampSession,
    userDetails: User,
    principalPrivateKey: string,
    principalPublicKey: string,
    principalExpiresAt: string | undefined,
  ) {
    const userId = userDetails.id

    await SecureStorage.setItem(
      `principal_credentials_${userId}`,
      JSON.stringify({
        privateKey: principalPrivateKey,
        publicKey: principalPublicKey,
        expiresAt: principalExpiresAt,
      }),
    )

    const storageKey = `device_credentials_${userId}`
    const storedCredsStr = await SecureStorage.getItem(storageKey)

    if (!storedCredsStr) {
      console.log('Registering new device for user', userId)
      const deviceID = generateDeviceID()
      const { privateKey, publicKey } = await generateKeys()

      await authService.registerDevice(s, deviceID, publicKey)

      const creds = { deviceID, privateKey }
      await SecureStorage.setItem(storageKey, JSON.stringify(creds))
    }

    localStorage.setItem('last_active_user', String(userId))
    setUser(userDetails)
  }

  async function verifyLoginOtp(code: string) {
    const username = pendingLoginUsername.value
    const password = pendingLoginPassword.value
    if (!username || !password) {
      throw new Error('No pending login found.')
    }

    // Principal keypair — the account-level identity used to re-establish the
    // session on reload (autoLogin). Short-lived (server-side expiry) and
    // removed again on logout, unlike the permanent per-device keypair below.
    const { privateKey: principalPrivateKey, publicKey: principalPublicKey } = await generateKeys()

    const verifyResult = await authService.verifyLoginOtp(null, username, password, code, principalPublicKey)
    const principalExpiresAt = verifyResult?.args?.[0]?.expires_at

    // OTP confirmed, continue as the principal just registered, via cryptosign.
    const { session: s, result } = await authService.autoLogin(username, principalPrivateKey)
    session.value = s

    const userDetails = result.args[0]
    if (!userDetails || !userDetails.id) {
      await s.leave()
      throw new Error('Invalid user details received')
    }

    console.dir(userDetails)

    await completeAuthSession(s, userDetails, principalPrivateKey, principalPublicKey, principalExpiresAt)

    pendingLoginUsername.value = null
    pendingLoginPassword.value = null
  }

  async function getStoredCreds(storagePrefix: string) {
    const lastUserId = localStorage.getItem('last_active_user')
    const storedUserStr = localStorage.getItem('currentUser')

    if (!lastUserId || !storedUserStr) return false

    // Direct SecureStorage access (No migration)
    const storedCredsStr = await SecureStorage.getItem(`${storagePrefix}_${lastUserId}`)

    const storedUser = JSON.parse(storedUserStr)
    const authId = storedUser.email

    if (!storedCredsStr || !authId) return false

    const { privateKey, publicKey, expiresAt } = JSON.parse(storedCredsStr)

    return { authId, privateKey, publicKey, expiresAt }
  }

  // The permanent per-device keypair (shell/desktop access) — unaffected by
  // login-session expiry, kept until the device itself is removed.
  async function getDeviceCreds() {
    return getStoredCreds('device_credentials')
  }

  // The short-lived principal keypair created at login (autoLogin only).
  async function getPrincipalCreds() {
    return getStoredCreds('principal_credentials')
  }

  // Logs straight in to one machine running `deskconnd --standalone`. Connecting once
  // checks the credentials; the desktop opens its own sessions via shellWamp.
  async function loginStandalone(input: StandaloneCreds) {
    const creds = { ...input, url: normalizeStandaloneURL(input.url) }
    const s = await wampService.connectStandalone(creds, STANDALONE_REALM)
    await s.leave().catch(console.error)

    await SecureStorage.setItem(STANDALONE_CREDS_KEY, JSON.stringify(creds))
    standalone.value = creds
    setUser({ id: 'standalone', name: creds.authId })
  }

  async function shellWamp(realm: string) {
    if (standalone.value) return wampService.connectStandalone(standalone.value, realm)

    const creds = await getDeviceCreds()
    if (!creds) return false

    return await authService.shellDesktop(creds.authId, creds.privateKey, realm)
  }

  async function shellWebRTC(realm: string, routed: WampSession) {
    if (standalone.value) {
      return authService.shellWebRTCDesktop(standaloneAuthenticator(standalone.value), realm, routed)
    }

    const creds = await getDeviceCreds()
    if (!creds) return false

    const authenticator = new CryptoSignAuthenticator(creds.authId, creds.privateKey, {})
    return await authService.shellWebRTCDesktop(authenticator, realm, routed)
  }

  // Drops a principal key that's no longer good (expired/deleted/rejected)
  // instead of retrying it forever on every load, and clears the stale
  // "logged in" state so the router sends the user back to /login.
  async function clearStalePrincipal() {
    const staleUserId = localStorage.getItem('last_active_user')
    if (staleUserId) await SecureStorage.removeItem(`principal_credentials_${staleUserId}`)
    localStorage.removeItem('last_active_user')
    setUser(null)
  }

  // Rotates the principal key once it's close enough to expiry that it might
  // lapse before the user's next visit — otherwise they'd get silently logged
  // out mid-expiry with no chance to renew.
  const PRINCIPAL_ROTATE_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000

  async function rotatePrincipalIfExpiringSoon(
    s: WampSession,
    userId: string,
    creds: { publicKey: string; expiresAt?: string },
  ) {
    if (!creds.expiresAt) return
    if (new Date(creds.expiresAt).getTime() - Date.now() > PRINCIPAL_ROTATE_THRESHOLD_MS) return

    try {
      const { privateKey: newPrivateKey, publicKey: newPublicKey } = await generateKeys()
      const result = await authService.rotatePrincipal(s, creds.publicKey, newPublicKey)
      const newExpiresAt = result?.args?.[0]?.expires_at

      await SecureStorage.setItem(
        `principal_credentials_${userId}`,
        JSON.stringify({ privateKey: newPrivateKey, publicKey: newPublicKey, expiresAt: newExpiresAt }),
      )
    } catch (e) {
      // Non-fatal: the old key is still valid until it actually expires, retry on next load.
      console.error('Principal rotation failed', e)
    }
  }

  async function autoLogin() {
    // Standalone: nothing to check up front, an unreachable machine shows as disconnected.
    const standaloneCreds = await SecureStorage.getItem(STANDALONE_CREDS_KEY)
    if (standaloneCreds) {
      standalone.value = JSON.parse(standaloneCreds)
      setUser({ id: 'standalone', name: standalone.value!.authId })
      return true
    }

    const creds = await getPrincipalCreds()
    if (!creds) {
      // No principal creds — either a fresh browser, or a session left over
      // from before principal creds existed. Either way `user` must not stay
      // stale-authenticated, or the router bounces /login back to / forever.
      await clearStalePrincipal()
      return false
    }

    // Expired principal — the server will reject it anyway, so skip the
    // round-trip and go straight to a fresh login.
    if (creds.expiresAt && new Date(creds.expiresAt) <= new Date()) {
      await clearStalePrincipal()
      return false
    }

    try {
      // Connect with stored credentials
      const { session: s, result } = await authService.autoLogin(creds.authId, creds.privateKey)
      session.value = s

      const userDetails = result.args[0]
      if (!userDetails || !userDetails.id) {
        await s.leave()
        await clearStalePrincipal()
        return false
      }

      console.dir(userDetails)
      // Update local user state in case details changed on server
      setUser(userDetails)

      await rotatePrincipalIfExpiringSoon(s, String(userDetails.id), creds)

      return true
    } catch (e) {
      // Router either denied the reconnect (expired/deleted principal) or the
      // machine is unreachable.
      console.error('Auto-login failed', e)
      await clearStalePrincipal()
      return false
    }
  }

  async function logout() {
    if (standalone.value) {
      await SecureStorage.removeItem(STANDALONE_CREDS_KEY)
      standalone.value = null
      useSessionCacheStore().invalidateAll()
      // A cloud login afterwards must not get bounced into the standalone realm.
      useSettingsStore().clearLastRealm()
      setUser(null)
      return
    }

    const s = session.value
    const lastUserId = localStorage.getItem('last_active_user')

    if (s && lastUserId) {
      const storedCredsStr = await SecureStorage.getItem(`principal_credentials_${lastUserId}`)
      if (storedCredsStr) {
        const { publicKey } = JSON.parse(storedCredsStr)
        await authService.deletePrincipal(s, publicKey).catch(console.error)
      }
    }

    if (lastUserId) await SecureStorage.removeItem(`principal_credentials_${lastUserId}`)

    useSessionCacheStore().invalidateAll()
    session.value?.leave().catch(console.error)
    session.value = null
    setUser(null)
    localStorage.removeItem('last_active_user')
  }

  async function updateProfile(name: string, password?: string) {
    if (!session.value) throw new Error('No active session')

    await authService.updateAccount(session.value, name, password)

    // Update local state if successful
    if (user.value) {
      const updatedUser = { ...user.value, name }
      setUser(updatedUser)
    }
  }

  return {
    user,
    isAuthenticated,
    pendingUsername,
    pendingLoginUsername,
    session,
    standalone,
    login,
    loginStandalone,
    verifyLoginOtp,
    register,
    verifyAccount,
    resendOtp,
    autoLogin,
    forgotPassword,
    resetPassword,
    logout,
    updateProfile,
    shellWamp,
    shellWebRTC,
  }
})
