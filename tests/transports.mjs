import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

const executable = process.env.CHROMIUM_BIN
const binary = process.env.XCONN_TRANSPORT_PEER
if (!executable || !binary) throw new Error('Set CHROMIUM_BIN and XCONN_TRANSPORT_PEER')
const fixture = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const profile = await mkdtemp(join(tmpdir(), 'deskconn-web-test-'))
let browser
let vite
let socket
try {
  const lines = createInterface({ input: fixture.stdout })
  const [line] = await once(lines, 'line')
  lines.close()
  const addresses = JSON.parse(line)
  vite = await createServer({ server: { host: '127.0.0.1', port: 0, open: false } })
  await vite.listen()
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`
  browser = spawn(
    executable,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let port
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
      break
    } catch {
      await delay(100)
    }
  }
  if (!port) throw new Error('Chromium did not start')
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(
    pages.find((page) => page.type === 'page' && page.url === 'about:blank').webSocketDebuggerUrl,
  )
  await once(socket, 'open')
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id) return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  await call('Page.navigate', { url: `${url}/tests/empty.html` })
  await delay(500)
  const result = await Promise.race([
    call('Runtime.evaluate', {
      expression: `import('/tests/transports.ts').then(module => module.exercise(${JSON.stringify(addresses)}))`,
      awaitPromise: true,
      returnByValue: true,
    }),
    delay(30000, undefined, { ref: false }).then(() => {
      throw new Error('Browser transport tests timed out')
    }),
  ])
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  console.log(result.result.value)
} finally {
  socket?.close()
  browser?.kill()
  if (browser) await once(browser, 'exit').catch(() => {})
  await vite?.close()
  fixture.stdin.end()
  await once(fixture, 'exit').catch(() => {})
  await rm(profile, { recursive: true, force: true })
}
