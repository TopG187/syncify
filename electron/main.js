const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const { PeerHub } = require('../lib/peer-hub');
const { ClipboardSync } = require('../lib/clipboard-sync');
const { InputBridge } = require('../lib/input-bridge');

let mainWindow = null;
let tray = null;
let hub = null;
let clipboardSync = null;
let inputBridge = null;
let controllingRemote = false;

const DEFAULT_PORT = 24892;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 680,
    minWidth: 380,
    minHeight: 560,
    title: 'Syncify',
    backgroundColor: '#12161a',
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
  // 16x16 simple template-ish PNG as data URL → nativeImage
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVQ4T2NkYGD4z0ABYBzVMKoBBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY',
    'base64'
  );
  let icon = nativeImage.createFromBuffer(png);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
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
    if (status.state === 'paired' || status.state === 'hosting' || status.state === 'connected') {
      if (!controllingRemote) inputBridge.startEdgeWatch();
    }
    if (status.state === 'idle') inputBridge.stopEdgeWatch();
  });
  hub.on('peer', (info) => sendToUI('peer', info));
  hub.on('log', (msg) => sendToUI('log', msg));

  hub.on('control-enter', async () => {
    controllingRemote = true;
    updateTrayMenu();
    sendToUI('control', { remote: true });
    await inputBridge.startCapturing();
  });

  hub.on('control-leave', async () => {
    controllingRemote = false;
    updateTrayMenu();
    sendToUI('control', { remote: false });
    await inputBridge.stopCapturing();
    await inputBridge.nudgeInward(hub.getLayout());
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

app.whenReady().then(() => {
  // Leaner footprint
  app.commandLine.appendSwitch('disable-renderer-backgrounding');

  hub = new PeerHub({ defaultPort: DEFAULT_PORT });
  clipboardSync = new ClipboardSync({
    getText: () => clipboard.readText(),
    setText: (t) => clipboard.writeText(t),
    onLocalChange: (text) => hub.sendClipboard(text),
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
    return {
      hostname: os.hostname(),
      platform: process.platform,
      addresses: getLocalAddresses(),
      defaultPort: DEFAULT_PORT,
      screen: primary.size,
      displays,
      layout: hub.getLayout(),
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
      return { ok: true };
    } catch (err) {
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
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  clipboardSync?.stop();
  inputBridge?.stopEdgeWatch();
  await inputBridge?.stopCapturing();
  await hub?.disconnect();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

process.on('uncaughtException', (err) => {
  console.error(err);
});
