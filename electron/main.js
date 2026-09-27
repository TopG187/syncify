const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const { PeerHub } = require('../lib/peer-hub');
const { ClipboardSync } = require('../lib/clipboard-sync');
const { CopyWatcher } = require('../lib/copy-watcher');
const { InputBridge } = require('../lib/input-bridge');
const { SessionStore } = require('../lib/session-store');
const { SettingsStore } = require('../lib/settings-store');

let mainWindow = null;
let tray = null;
let hub = null;
let clipboardSync = null;
let copyWatcher = null;
let inputBridge = null;
let controllingRemote = false;
let beingControlled = false;
let sessionStore = null;
let settingsStore = null;
let mouseShareEnabled = true;

const DEFAULT_PORT = 24892;

function syncEdgeWatch() {
  if (!inputBridge) return;
  if (mouseShareEnabled && !controllingRemote && !beingControlled && hub?.wantedActive) {
    inputBridge.startEdgeWatch();
  } else {
    inputBridge.stopEdgeWatch();
  }
}

async function setMouseShareEnabled(on) {
  mouseShareEnabled = !!on;
  settingsStore?.set({ mouseShareEnabled });
  if (!mouseShareEnabled) {
    await forceLocalControl('Mouse sync turned off');
  } else {
    inputBridge?.blockRemote(0);
    syncEdgeWatch();
    sendToUI('log', 'Mouse sync on — drag off the layout edge to control the other machine');
  }
  sendToUI('settings', { mouseShareEnabled });
  updateTrayMenu();
  return mouseShareEnabled;
}

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
        label: controllingRemote
          ? 'Controlling remote…'
          : beingControlled
            ? 'Being controlled…'
            : 'Local control',
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
        label: mouseShareEnabled ? 'Mouse sync: On' : 'Mouse sync: Off',
        click: () => setMouseShareEnabled(!mouseShareEnabled),
      },
      {
        label: 'Stop remote mouse (fix me)',
        click: () => forceLocalControl('Stopped from tray'),
      },
      {
        label: 'Return control',
        enabled: controllingRemote || beingControlled,
        click: () => forceLocalControl('Control released'),
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
    if (status.state === 'idle') {
      inputBridge.stopEdgeWatch();
      inputBridge.stopGuard();
      return;
    }
    if (
      status.state === 'paired' ||
      status.state === 'hosting' ||
      status.state === 'connected' ||
      status.state === 'reconnecting'
    ) {
      syncEdgeWatch();
    }
  });
  hub.on('log', (msg) => sendToUI('log', msg));

  hub.on('being-controlled', async (on) => {
    if (!mouseShareEnabled) {
      beingControlled = false;
      hub.beingControlled = false;
      try {
        hub.send({ type: 'release' });
      } catch {
        /* ignore */
      }
      await inputBridge.stopGuard();
      inputBridge.stopEdgeWatch();
      return;
    }
    beingControlled = !!on;
    updateTrayMenu();
    if (beingControlled) {
      inputBridge.stopEdgeWatch();
      if (controllingRemote) {
        controllingRemote = false;
        await inputBridge.stopCapturing();
      }
      await inputBridge.startGuard();
    } else {
      inputBridge.releaseInjectedModifiers();
      await inputBridge.stopGuard();
      syncEdgeWatch();
    }
    sendToUI('control', { remote: controllingRemote, beingControlled });
  });

  hub.on('control-enter', async () => {
    if (!mouseShareEnabled) {
      await forceLocalControl('Mouse sync is off');
      return;
    }
    controllingRemote = true;
    beingControlled = false;
    updateTrayMenu();
    sendToUI('control', { remote: true, beingControlled: false });
    clipboardSync.flush();
    inputBridge.stopEdgeWatch();
    await inputBridge.stopGuard();
    await inputBridge.startCapturing();
  });

  hub.on('control-leave', async () => {
    controllingRemote = false;
    updateTrayMenu();
    sendToUI('control', { remote: false, beingControlled });
    await inputBridge.stopCapturing();
    await inputBridge.nudgeInward(hub.getLayout());
    clipboardSync.flush(true);
    syncEdgeWatch();
  });

  hub.on('remote-input', (msg) => {
    if (!mouseShareEnabled) return;
    if (msg?.t === 'hotkey-release') {
      forceLocalControl('Peer released');
      return;
    }
    if (controllingRemote) return;
    if (!beingControlled) return;
    inputBridge.applyRemote(msg);
  });

  hub.on('clipboard', (text) => {
    clipboardSync.applyRemote(text);
    sendToUI('log', text ? `Clipboard synced ← peer (${text.length} chars)` : 'Clipboard cleared ← peer');
  });

  hub.on('peer', (info) => {
    sendToUI('peer', info);
    if (info) {
      setTimeout(() => clipboardSync.flush(true), 200);
      setTimeout(() => clipboardSync.flush(true), 800);
    }
  });
}

/** Emergency: stop remote mouse takeover and reclaim this machine. */
async function forceLocalControl(reason) {
  if (!inputBridge) return;
  inputBridge.blockRemote(5000);
  inputBridge.releaseInjectedModifiers();
  await inputBridge.stopCapturing();
  await inputBridge.stopGuard();
  try {
    require('../lib/cursor-hide').forceShowCursor();
  } catch {
    /* ignore */
  }
  if (controllingRemote) {
    controllingRemote = false;
    try {
      await hub.releaseControl();
    } catch {
      /* ignore */
    }
  }
  if (beingControlled) {
    beingControlled = false;
    hub.beingControlled = false;
    try {
      hub.send({ type: 'release' });
    } catch {
      /* ignore */
    }
    // Avoid re-entrancy storms — update UI directly
  }
  updateTrayMenu();
  sendToUI('control', { remote: false, beingControlled: false });
  if (reason) sendToUI('log', reason);
  syncEdgeWatch();
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
  settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  const settings = settingsStore.load();
  mouseShareEnabled = settings.mouseShareEnabled !== false;

  hub = new PeerHub({ defaultPort: DEFAULT_PORT, sessionStore });
  clipboardSync = new ClipboardSync({
    getText: () => {
      try {
        // Prefer plain text; fall back to HTML stripped lightly if needed
        const plain = clipboard.readText('clipboard') || clipboard.readText() || '';
        if (plain) return plain;
        const html = clipboard.readHTML('clipboard') || clipboard.readHTML() || '';
        if (html) {
          return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        return '';
      } catch {
        try {
          return clipboard.readText() || '';
        } catch {
          return '';
        }
      }
    },
    setText: (t) => {
      const value = t == null ? '' : String(t);
      // Do NOT clear first — that briefly syncs empty clipboard to the peer
      try {
        clipboard.write({ text: value });
      } catch {
        try {
          clipboard.writeText(value, 'clipboard');
        } catch {
          clipboard.writeText(value);
        }
      }
      // OS-native fallback (helps macOS pasteboard reliability)
      try {
        const { execFileSync } = require('child_process');
        if (process.platform === 'darwin') {
          execFileSync('pbcopy', { input: value, encoding: 'utf8' });
        } else if (process.platform === 'win32') {
          execFileSync(
            'powershell.exe',
            ['-NoProfile', '-Command', 'Set-Clipboard -Value $input'],
            { input: value, encoding: 'utf8', windowsHide: true }
          );
        }
      } catch {
        /* ignore native fallback errors */
      }
    },
    onLocalChange: (text) => {
      if (!hub || !hub.socket) return;
      const ok = hub.sendClipboard(text);
      if (ok) {
        sendToUI(
          'log',
          text ? `Clipboard synced → peer (${text.length} chars)` : 'Clipboard cleared → peer'
        );
      }
    },
  });
  copyWatcher = new CopyWatcher({
    onCopy: () => clipboardSync.notifyCopy(),
  });
  inputBridge = new InputBridge({
    getDisplays: () => screen.getAllDisplays(),
    getCursor: () => screen.getCursorScreenPoint(),
    onLocalInput: (msg) => {
      if (msg?.t === 'hotkey-release') {
        forceLocalControl('Hotkey release');
        return;
      }
      if (!mouseShareEnabled) return;
      hub.sendInput(msg);
    },
    onEdgeLeave: (hit) => {
      if (!mouseShareEnabled) return false;
      return hub.tryLeaveViaEdge(hit);
    },
    onLocalReclaim: () => forceLocalControl('Local mouse reclaimed control'),
    onClipboardHint: (kind) => {
      // Push clipboard before remote sees Copy/Paste keys
      clipboardSync.flush(true);
      if (kind === 'copy') {
        setTimeout(() => clipboardSync.notifyCopy(), 100);
      }
    },
    isControllingRemote: () => controllingRemote,
    isBeingControlled: () => beingControlled,
    getPeerScreen: () => hub.getPeerScreen(),
    getLayout: () => hub.getLayout(),
  });

  setupHubHandlers();
  createWindow();
  createTray();
  clipboardSync.start();
  copyWatcher.start();

  // Clear any stuck capture from a previous crash
  await inputBridge.stopCapturing();
  await inputBridge.stopGuard();
  controllingRemote = false;
  beingControlled = false;

  const panic = () => forceLocalControl('Panic hotkey — local control');
  globalShortcut.register('CommandOrControl+Alt+Backspace', panic);
  globalShortcut.register('CommandOrControl+Shift+Escape', panic);

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
      mouseShareEnabled,
    };
  });

  ipcMain.handle('set-mouse-share', async (_e, enabled) => {
    const value = await setMouseShareEnabled(!!enabled);
    return { ok: true, mouseShareEnabled: value };
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
    await forceLocalControl('Disconnected');
    await hub.disconnect();
    return { ok: true };
  });

  ipcMain.handle('set-layout', (_e, layout) => {
    hub.setLayout(layout);
    return { ok: true, layout: hub.getLayout() };
  });

  ipcMain.handle('release-control', async () => {
    await forceLocalControl('Released from UI');
    return { ok: true };
  });

  setTimeout(() => {
    hub.restoreSession().catch((err) => console.error('restoreSession', err));
  }, 600);
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  clipboardSync?.stop();
  copyWatcher?.stop();
  inputBridge?.stopEdgeWatch();
  await inputBridge?.stopCapturing();
  await inputBridge?.stopGuard();
  // Keep session file so next start auto-reconnects
  await hub?.shutdown();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

process.on('uncaughtException', (err) => {
  console.error(err);
});
