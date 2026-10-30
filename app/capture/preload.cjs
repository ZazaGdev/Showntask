// The overlay windows' only bridge, on their own channels.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recwin', {
  init: () => ipcRenderer.invoke('capture:win-init'),
  send: (what, data) => ipcRenderer.send('capture:win', what, data),
  onState: fn => ipcRenderer.on('capture:win-state', (_e, s) => fn(s)),
});
