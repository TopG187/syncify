const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('syncify', {
  getInfo: () => ipcRenderer.invoke('get-info'),
  host: (opts) => ipcRenderer.invoke('host', opts),
  connect: (opts) => ipcRenderer.invoke('connect', opts),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  setLayout: (layout) => ipcRenderer.invoke('set-layout', layout),
  releaseControl: () => ipcRenderer.invoke('release-control'),
  setMouseShare: (enabled) => ipcRenderer.invoke('set-mouse-share', enabled),
  onStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
  onPeer: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('peer', handler);
    return () => ipcRenderer.removeListener('peer', handler);
  },
  onLog: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.removeListener('log', handler);
  },
  onControl: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('control', handler);
    return () => ipcRenderer.removeListener('control', handler);
  },
  onSettings: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('settings', handler);
    return () => ipcRenderer.removeListener('settings', handler);
  },
});
