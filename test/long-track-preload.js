const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dj', {
  loadState: async () => null, saveState: async () => {},
  pickFiles: () => ipcRenderer.invoke('fixture-paths'), pickFolder: async () => [],
  readAudio: path => ipcRenderer.invoke('fixture-read', path),
  audioMeta: path => ipcRenderer.invoke('fixture-meta', path),
  startupPhase: () => {}, onQuickAction: () => {}, setQuickControlState: () => {}
});
