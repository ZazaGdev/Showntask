// The main window's only bridge: named requests to the main side, and its news.
const { contextBridge, ipcRenderer } = require('electron');

const NEWS = ['progress', 'recorder', 'changed'];
contextBridge.exposeInMainWorld('api', {
  call: (name, ...args) => ipcRenderer.invoke(`api:${name}`, ...args),
  on: (ch, fn) => { if (NEWS.includes(ch)) ipcRenderer.on(ch, (_e, v) => fn(v)); },
});
