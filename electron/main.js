const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const { PeerHub } = require('../lib/peer-hub');
const { ClipboardSync } = require('../lib/clipboard-sync');
const { InputBridge } = require('../lib/input-bridge');
const { SessionStore } = require('../lib/session-store');

let mainWindow = null;
let tray = null;
let hub = null;
let clipboardSync = null;
let inputBridge = null;
let controllingRemote = false;
let sessionStore = null;

const DEFAULT_PORT = 24892;

function appIcon() {
  const ico = path.join(__dirname, '..', 'assets', 'icon.ico');
  const png = path.join(__dirname, '..', 'assets', 'icon-256.png');
  const fallback = path.join(__dirname, '..', 'assets', 'icon.png');
  for (const p of [ico, png, fallback]) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    } catch {
      /* try next */
    }
  }
  return nativeImage.createEmpty();
}

function trayIcon() {
  const tray = path.join(__dirname, '..', 'assets', 'tray.png');
  const png = path.join(__dirname, '..', 'assets', 'icon-256.png');
  for (const p of [tray, png]) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    } catch {
      /* try next */
    }
  }
  return appIcon();
}

function createWindow() {
  const icon = appIcon();
  mainWindow = new BrowserWindow({
    width: 440,
    height: 680,
    minWidth: 380,
    minHeight: 560,
    title: 'Syncify',
    backgroundColor: '#12161a',
    icon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Syncify');
  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: controllingRemote ? 'Controlling remote…' : 'Local control',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Show Syncify',
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      {
        label: 'Return control',
        enabled: controllingRemote,
        click: () => hub?.releaseControl(),
      },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

function sendToUI(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getLocalAddresses() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        list.push({ iface: name, address: net.address });
      }
    }
  }
  return list;
}

function setupHubHandlers() {
  hub.on('status', (status) => {
    sendToUI('status', status);
    if (
      status.state === 'paired' ||
      status.state === 'hosting' ||
      status.state === 'connected' ||
      status.state === 'reconnecting'
    ) {
      if (!controllingRemote) inputBridge.startEdgeWatch();
    }
    if (status.state === 'idle') inputBridge.stopEdgeWatch();
  });
  hub.on('log', (msg) => sendToUI('log', msg));

  hub.on('control-enter', async () => {
    controllingRemote = true;
    updateTrayMenu();
    sendToUI('control', { remote: true });
    clipboardSync.flush();
    await inputBridge.startCapturing();
  });

  hub.on('control-leave', async () => {
    controllingRemote = false;
    updateTrayMenu();
    sendToUI('control', { remote: false });
    await inputBridge.stopCapturing();
    await inputBridge.nudgeInward(hub.getLayout());
    clipboardSync.flush();
  });

  hub.on('remote-input', (msg) => {
    if (msg?.t === 'hotkey-release') {
      hub.releaseControl();
      return;
    }
    inputBridge.applyRemote(msg);
  });

  hub.on('clipboard', (text) => {
    clipboardSync.applyRemote(text);
    if (text) sendToUI('log', 'Clipboard synced ← peer');
  });

  hub.on('peer', (info) => {
    sendToUI('peer', info);
    if (info) setTimeout(() => clipboardSync.flush(), 150);
  });
}

function listDisplays() {
  const displays = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    size: d.size,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
  // Label left → right by x position
  const sorted = [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
  const labels =
    sorted.length === 1
      ? ['This screen']
      : sorted.length === 2
        ? ['Left', 'Middle']
        : sorted.map((_, i) => {
            if (i === 0) return 'Left';
            if (i === sorted.length - 1) return 'Right';
            return sorted.length === 3 ? 'Middle' : `Display ${i + 1}`;
          });
  sorted.forEach((d, i) => {
    d.label = labels[i];
    d.order = i;
  });
  return sorted;
}

app.whenReady().then(async () => {
  // Leaner footprint
  app.commandLine.appendSwitch('disable-renderer-backgrounding');

  sessionStore = new SessionStore(path.join(app.getPath('userData'), 'session.json'));
  hub = new PeerHub({ defaultPort: DEFAULT_PORT, sessionStore });
  clipboardSync = new ClipboardSync({
    getText: () => {
      try {
        return clipboard.readText('clipboard') || '';
      } catch {
        return clipboard.readText() || '';
      }
    },
    setText: (t) => {
      const value = t == null ? '' : String(t);
      try {
        clipboard.clear('clipboard');
      } catch {
        try {
          clipboard.clear();
        } catch {
          /* ignore */
        }
      }
      try {
        clipboard.writeText(value, 'clipboard');
      } catch {
        clipboard.writeText(value);
      }
      // Also write via write() for better macOS pasteboard compatibility
      try {
        clipboard.write({ text: value });
      } catch {
        /* ignore */
      }
    },
    onLocalChange: (text) => {
      const ok = hub.sendClipboard(text);
      if (ok && text) sendToUI('log', 'Clipboard synced → peer');
    },
  });
  inputBridge = new InputBridge({
    getDisplays: () => screen.getAllDisplays(),
    getCursor: () => screen.getCursorScreenPoint(),
    onLocalInput: (msg) => {
      if (msg?.t === 'hotkey-release') {
        hub.releaseControl();
        return;
      }
      hub.sendInput(msg);
    },
    onEdgeLeave: (hit) => hub.tryLeaveViaEdge(hit),
    isControllingRemote: () => controllingRemote,
    getPeerScreen: () => hub.getPeerScreen(),
    getLayout: () => hub.getLayout(),
  });

  setupHubHandlers();
  createWindow();
  createTray();
  clipboardSync.start();

  globalShortcut.register('CommandOrControl+Alt+Backspace', () => {
    hub.releaseControl();
  });

  ipcMain.handle('get-info', () => {
    const displays = listDisplays();
    const primary = screen.getPrimaryDisplay();
    const saved = sessionStore.load();
    return {
      hostname: os.hostname(),
      platform: process.platform,
      addresses: getLocalAddresses(),
      defaultPort: DEFAULT_PORT,
      screen: primary.size,
      displays,
      layout: hub.getLayout(),
      session: hub.getSession() || saved,
      inputReady: inputBridge.available,
      inputError: inputBridge.loadError ? String(inputBridge.loadError.message || inputBridge.loadError) : null,
    };
  });

  ipcMain.handle('host', async (_e, { port, layout }) => {
    try {
      await hub.host(Number(port) || DEFAULT_PORT, layout);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('connect', async (_e, { host, port, layout }) => {
    try {
      await hub.connect(String(host).trim(), Number(port) || DEFAULT_PORT, layout);
      const reconnecting = hub.role === 'client' && !hub.socket;
      return { ok: true, reconnecting };
    } catch (err) {
      if (hub.wantedActive && hub.role === 'client') {
        return { ok: true, reconnecting: true };
      }
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('disconnect', async () => {
    await inputBridge.stopCapturing();
    inputBridge.stopEdgeWatch();
    controllingRemote = false;
    updateTrayMenu();
    await hub.disconnect();
    return { ok: true };
  });

  ipcMain.handle('set-layout', (_e, layout) => {
    hub.setLayout(layout);
    return { ok: true, layout: hub.getLayout() };
  });

  ipcMain.handle('release-control', async () => {
    await hub.releaseControl();
    return { ok: true };
  });

  // Resume last link after launch (sleep / reboot / quit)
  setTimeout(() => {
    hub.restoreSession().catch((err) => console.error('restoreSession', err));
  }, 600);
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  clipboardSync?.stop();
  inputBridge?.stopEdgeWatch();
  await inputBridge?.stopCapturing();
  // Keep session file so next start auto-reconnects
  await hub?.shutdown();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

process.on('uncaughtException', (err) => {
  console.error(err);
});
