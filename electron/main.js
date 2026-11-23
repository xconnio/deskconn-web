// Electron shell for the DeskConn web client. The renderer is the unmodified
// Vite build, served from app://deskconn so it gets a stable, secure origin
// (persistent IndexedDB, service worker, history-mode router, WebTransport).
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, net, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    },
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

// ── Port forwarding (src/services/portStream.ts) ──
// The page can't open sockets, so it asks for them here. Each TCP connection
// is handed over as a MessagePort carrying the socket's bytes; the page does
// the encryption and the stream to the machine. Loopback only.

// Unacked bytes a socket may post before it's paused. Mirrors portStream.ts.
const PORT_WINDOW = 1024 * 1024

/** Per page: its listeners (by id) and every socket it owns. */
const pages = new Map()

function pageOf(contents) {
  let page = pages.get(contents)
  if (!page) {
    page = { servers: new Map(), sockets: new Set() }
    pages.set(contents, page)
  }
  return page
}

// Page reloads or closes: drop everything it had open.
function closePage(contents) {
  const page = pages.get(contents)
  if (!page) return
  pages.delete(contents)
  for (const server of page.servers.values()) server.close()
  for (const socket of page.sockets) socket.destroy()
}

function checkSender(event) {
  if (!isAppUrl(event.senderFrame?.url ?? '')) throw new Error('not allowed')
}

function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port ${port}`)
}

/** Pipes a connected socket through a new MessagePort; returns the page's end. */
function bridge(socket, page) {
  page.sockets.add(socket)
  const { port1, port2 } = new MessageChannelMain()
  let inflight = 0
  let ended = false
  const end = (message) => {
    if (ended) return
    ended = true
    port1.postMessage(message ? { type: 'error', message } : { type: 'end' })
    port1.close()
  }
  socket.on('data', (chunk) => {
    if (ended) return
    inflight += chunk.length
    port1.postMessage(new Uint8Array(chunk)) // a copy: chunk may share a pooled buffer
    if (inflight > PORT_WINDOW) socket.pause()
  })
  socket.on('error', (err) => end(err.message))
  socket.on('close', () => { page.sockets.delete(socket); end() })
  port1.on('message', ({ data }) => {
    if (ArrayBuffer.isView(data)) {
      socket.write(data, () => { if (!ended) port1.postMessage({ type: 'ack', bytes: data.byteLength }) })
    } else if (data?.type === 'ack') {
      inflight -= data.bytes
      if (inflight <= PORT_WINDOW) socket.resume()
    } else if (data?.type === 'end') {
      // end(), not destroy(): bytes still buffered by write() must reach the client.
      ended = true
      port1.close()
      socket.end()
      setTimeout(() => socket.destroy(), 30_000).unref() // client never closes its side
    } else {
      ended = true
      port1.close()
      socket.destroy()
    }
  })
  // The page went away without saying 'end'.
  port1.on('close', () => { if (!ended) { ended = true; socket.destroy() } })
  port1.start()
  return port2
}

ipcMain.handle('ports:listen', async (event, localPort) => {
  checkSender(event)
  checkPort(localPort)
  const contents = event.sender
  const page = pageOf(contents)
  const id = randomUUID()
  const sockets = new Set()
  const server = createServer((socket) => {
    if (contents.isDestroyed()) return socket.destroy()
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    contents.postMessage('ports:conn', { id }, [bridge(socket, page)])
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(localPort, '127.0.0.1', resolve)
  })
  server.removeAllListeners('error')
  server.on('error', (err) => { console.error(`port ${localPort} listener:`, err.message); server.close() })
  server.on('close', () => { for (const socket of sockets) socket.destroy() })
  page.servers.set(id, server)
  return id
})

ipcMain.handle('ports:close', (event, id) => {
  checkSender(event)
  const page = pages.get(event.sender)
  page?.servers.get(id)?.close()
  page?.servers.delete(id)
})

ipcMain.on('ports:dial', (event, requestId, localPort) => {
  const contents = event.sender
  const reply = (error, port) => {
    if (!contents.isDestroyed()) contents.postMessage('ports:dialed', { requestId, error }, port ? [port] : [])
  }
  try {
    checkSender(event)
    checkPort(localPort)
  } catch (err) {
    return reply(err.message)
  }
  const socket = createConnection({ port: localPort, host: '127.0.0.1' })
  socket.once('error', (err) => reply(err.message))
  socket.once('connect', () => {
    socket.removeAllListeners('error')
    if (contents.isDestroyed()) return socket.destroy()
    reply(undefined, bridge(socket, pageOf(contents)))
  })
})

// Applied to every window, including ones the app opens (e.g. Ctrl+click on a link).
app.on('web-contents-created', (_e, contents) => {
  contents.on('destroyed', () => closePage(contents))
  contents.on('did-navigate', () => closePage(contents)) // reloads; SPA route changes are in-page

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
