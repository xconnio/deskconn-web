// Electron shell for the DeskConn web client. The renderer is the unmodified
// Vite build, served from app://deskconn so it gets a stable, secure origin
// (persistent IndexedDB, service worker, history-mode router, WebTransport).
import { app, BrowserWindow, dialog, net, protocol, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEME = 'app'
const ORIGIN = `${SCHEME}://deskconn`
const DIST = path.join(import.meta.dirname, '..', 'dist')
// `npm run electron:dev` passes --dev-url=http://localhost:5173 to load the Vite dev server.
const DEV_URL = process.argv.find((a) => a.startsWith('--dev-url='))?.slice('--dev-url='.length)

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true, stream: true },
  },
])

// Same contract as docker-entrypoint.sh: keys in <userData>/config.json
// (WAMP_WT_URL, WAMP_WT_CERT_URL, WAMP_REALM, REGISTRATION_AUTHID) override
// the values baked into the build.
async function configJs() {
  let config = {}
  try {
    config = JSON.parse(await readFile(path.join(app.getPath('userData'), 'config.json'), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('ignoring invalid config.json:', err.message)
  }
  return new Response(`window.__APP_CONFIG__ = ${JSON.stringify(config)};`, {
    headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
  })
}

async function serve(request) {
  const { pathname } = new URL(request.url)
  if (pathname === '/config.js') return configJs()

  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return new Response('Bad request', { status: 400 }) }
  const file = path.normalize(path.join(DIST, decoded))
  if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 })

  const res = await net.fetch(pathToFileURL(file).toString()).catch(() => null)
  if (res?.ok) return res
  // History-mode router: everything outside /assets/ gets the SPA shell. Not an
  // extension check: realm names have dots (/machine/com.deskconn.standalone).
  if (pathname.startsWith('/assets/')) return new Response('Not found', { status: 404 })
  return net.fetch(pathToFileURL(path.join(DIST, 'index.html')).toString())
}

// Not URL.origin: Node reports "null" as the origin of custom schemes like app:.
function originOf(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}` } catch { return null }
}

function isAppUrl(url) {
  const origin = originOf(url)
  return origin !== null && (origin === ORIGIN || (DEV_URL !== undefined && origin === originOf(DEV_URL)))
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: path.join(import.meta.dirname, 'resources', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  if (DEV_URL) {
    // Vite may still be starting when Electron launches. -3 is ERR_ABORTED
    // (a navigation superseded by another), not a failure worth retrying.
    win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3 && isAppUrl(url)) setTimeout(() => win.loadURL(url), 500)
    })
  }
  win.loadURL(DEV_URL ?? `${ORIGIN}/`)
}

// Applied to every window, including ones the app opens (e.g. Ctrl+click on a link).
app.on('web-contents-created', (_e, contents) => {
  // Links to anything other than the app open in the system browser.
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' }
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
  })

  // The app blocks unload while sessions are open (App.vue's beforeunload).
  // Chrome asks "Leave site?"; Electron silently cancels, so ask here instead.
  contents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(BrowserWindow.fromWebContents(contents), {
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      title: 'DeskConn',
      message: 'You have open sessions. Leave anyway?',
      detail: 'Open terminals, file transfers, and windows will be disconnected.',
    })
    if (choice === 0) event.preventDefault() // preventDefault here means "unload anyway"
  })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
    else if (app.isReady()) createWindow() // macOS keeps running with no windows
  })

  app.whenReady().then(() => {
    protocol.handle(SCHEME, serve)
    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
