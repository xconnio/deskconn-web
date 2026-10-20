import { fileURLToPath, URL } from 'node:url'

import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import type { Plugin } from 'vite'

import { CONFIG_DEFAULTS } from './src/config.defaults'

function runtimeConfig(env: Record<string, string>): Record<string, string> {
  return {
    WAMP_WT_URL: env.VITE_WAMP_WT_URL ?? CONFIG_DEFAULTS.WAMP_WT_URL,
    WAMP_WT_CERT_URL: env.VITE_WAMP_WT_CERT_URL ?? CONFIG_DEFAULTS.WAMP_WT_CERT_URL,
    WAMP_REALM: env.VITE_WAMP_REALM ?? CONFIG_DEFAULTS.WAMP_REALM,
    REGISTRATION_AUTHID: env.VITE_REGISTRATION_AUTHID ?? CONFIG_DEFAULTS.REGISTRATION_AUTHID,
  }
}

function serviceWorkerDevPlugin(): Plugin {
  return {
    name: 'sw-download-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/sw-download.js', async (_req, res) => {
        const result = await server.transformRequest('/src/sw-download.ts')
        if (!result) { res.statusCode = 404; res.end(); return }
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.end(result.code)
      })
    },
  }
}

function appConfigDevPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'app-config-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.end(`window.__APP_CONFIG__ = ${JSON.stringify(runtimeConfig(env))};`)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      vue(),
      vueDevTools(),
      appConfigDevPlugin(env),
      serviceWorkerDevPlugin(),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    build: {
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          'sw-download': fileURLToPath(new URL('./src/sw-download.ts', import.meta.url)),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === 'sw-download' ? '[name].js' : 'assets/[name]-[hash].js',
        },
      },
    },
  }
})
