// Port forwarding bridge for src/services/portStream.ts; see electron/main.js.
// contextBridge can't pass MessagePorts, so they're relayed with postMessage.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- sandboxed preloads can't be ES modules
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deskconnTitleBar', process.platform === 'darwin' ? 'mac' : 'overlay')

contextBridge.exposeInMainWorld('deskconnPorts', {
  listen: (localPort) => ipcRenderer.invoke('ports:listen', localPort),
  close: (id) => ipcRenderer.invoke('ports:close', id),
  dial: (requestId, localPort) => ipcRenderer.send('ports:dial', requestId, localPort),
})

ipcRenderer.on('ports:conn', (event, { id }) => {
  window.postMessage({ deskconnPorts: 'conn', id }, location.origin, event.ports)
})
ipcRenderer.on('ports:dialed', (event, { requestId, error }) => {
  window.postMessage({ deskconnPorts: 'dialed', requestId, error }, location.origin, event.ports)
})
