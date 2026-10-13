import { CONFIG_DEFAULTS } from './config.defaults'

const runtimeConfig = (window as Window & { __APP_CONFIG__?: Record<string, string> }).__APP_CONFIG__ ?? {}

export const WAMP_WT_URL = runtimeConfig.WAMP_WT_URL ?? import.meta.env.VITE_WAMP_WT_URL ?? CONFIG_DEFAULTS.WAMP_WT_URL
export const WAMP_WT_CERT_URL =
  runtimeConfig.WAMP_WT_CERT_URL ?? import.meta.env.VITE_WAMP_WT_CERT_URL ?? CONFIG_DEFAULTS.WAMP_WT_CERT_URL
export const WAMP_REALM = runtimeConfig.WAMP_REALM ?? import.meta.env.VITE_WAMP_REALM ?? CONFIG_DEFAULTS.WAMP_REALM
export const REGISTRATION_AUTHID =
  runtimeConfig.REGISTRATION_AUTHID ?? import.meta.env.VITE_REGISTRATION_AUTHID ?? CONFIG_DEFAULTS.REGISTRATION_AUTHID

// Baked in at Docker build time from a GitHub Actions secret (see Dockerfile/docker.yml),
// not part of the runtime __APP_CONFIG__ path used for the vars above.
export const REGISTRATION_PRIVATE_KEY =
  import.meta.env.VITE_REGISTRATION_PRIVATE_KEY ?? CONFIG_DEFAULTS.REGISTRATION_PRIVATE_KEY

// Realm deskconnd serves in standalone mode (deskconnd --standalone), see deskconn's common.StandaloneRealm.
export const STANDALONE_REALM = 'io.xconn.deskconn.standalone'
