const EventEmitter = require('events');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const { normalizeLayout } = require('./layout');

/**
 * Peer hub: one side hosts a tiny WS server, the other connects.
 * Drag the mouse off the configured edge to control the other machine.
 * Ctrl+Alt+Backspace returns control. Clipboard syncs both ways always.
 */
class PeerHub extends EventEmitter {
  constructor({ defaultPort }) {
    super();
    this.defaultPort = defaultPort;
    this.server = null;
    this.wss = null;
    this.socket = null;
    this.role = null;
    /** Local exit: { edge, displayId } — which monitor edge leads to the peer */
    this.layout = { edge: 'right', displayId: null };
    this.peerInfo = null;
    this.localInfo = {
      name: os.hostname(),
      platform: process.platform,
    };
    /** true = cursor is on this machine; false = we are driving the peer */
    this.cursorHere = true;
    this._closing = false;
  }

  log(msg) {
    this.emit('log', msg);
  }

  setLayout(layout) {
    this.layout = normalizeLayout(layout, this.layout.displayId);
  }

  getLayout() {
    return normalizeLayout(this.layout);
  }

  async host(port, layout) {
    await this.disconnect();
    this.role = 'host';
    this.layout = normalizeLayout(layout);
    this.cursorHere = true;

    this.server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Syncify');
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this._bindSocket(ws));

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '0.0.0.0', () => resolve());
    });

    this.emit('status', { state: 'hosting', port, layout: this.layout });
    this.log(`Hosting on port ${port} — allow this port through your firewall`);
  }

  async connect(host, port, layout) {
    await this.disconnect();
    this.role = 'client';
    this.layout = normalizeLayout(layout);
    this.cursorHere = true;

    const url = `ws://${host}:${port}`;
    const ws = new WebSocket(url);

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Connection timed out')), 8000);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    this._bindSocket(ws);
    this.emit('status', { state: 'connected', host, port, layout: this.layout });
    this.log(`Connected to ${host}:${port}`);
  }

  _bindSocket(ws) {
    this.socket = ws;
    this._closing = false;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this._onMessage(msg);
    });

    ws.on('close', () => {
      if (this._closing) return;
      this.socket = null;
      this.peerInfo = null;
      this.emit('peer', null);
      this.emit('status', { state: this.role === 'host' ? 'hosting' : 'idle' });
      this.log('Peer disconnected');
      if (!this.cursorHere) {
        this.cursorHere = true;
        this.emit('control-leave');
      }
    });

    ws.on('error', (err) => this.log(`Socket error: ${err.message}`));

    this.send({
      type: 'hello',
      name: this.localInfo.name,
      platform: this.localInfo.platform,
      screen: this._screenSize(),
    });
  }

  _screenSize() {
    try {
      const { screen } = require('electron');
      return screen.getPrimaryDisplay().size;
    } catch {
      return { width: 1920, height: 1080 };
    }
  }

  _onMessage(msg) {
    switch (msg.type) {
      case 'hello':
        this.peerInfo = {
          name: msg.name,
          platform: msg.platform,
          screen: msg.screen || { width: 1920, height: 1080 },
        };
        this.emit('peer', this.peerInfo);
        this.emit('status', { state: 'paired', layout: this.layout });
        this.log(`Paired with ${msg.name} (${msg.platform})`);
        this.send({
          type: 'hello-ack',
          name: this.localInfo.name,
          platform: this.localInfo.platform,
          screen: this._screenSize(),
        });
        break;
      case 'hello-ack':
        if (this.peerInfo) {
          this.peerInfo.screen = msg.screen || this.peerInfo.screen;
          this.emit('peer', this.peerInfo);
        }
        break;
      case 'clipboard':
        this.emit('clipboard', msg.text || '');
        break;
      case 'input':
        // Peer is driving this machine — inject
        this.emit('remote-input', msg.payload);
        break;
      case 'enter':
        // Peer moved onto our screen; we just inject their events (no capture)
        this.log(`${this.peerInfo?.name || 'Peer'} is controlling this machine`);
        this.emit('status', { state: 'paired', beingControlled: true, layout: this.layout });
        break;
      case 'leave':
        this.log('Peer returned to their machine');
        this.emit('status', { state: 'paired', beingControlled: false, layout: this.layout });
        break;
      case 'release':
        // Peer asked us to drop remote control if we have it
        if (!this.cursorHere) {
          this.cursorHere = true;
          this.emit('control-leave');
          this.log('Control released by peer');
        }
        break;
      default:
        break;
    }
  }

  send(obj) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(obj));
    }
  }

  sendClipboard(text) {
    if (!this.socket) return;
    this.send({ type: 'clipboard', text: text || '' });
  }

  sendInput(payload) {
    if (!this.socket || this.cursorHere) return;
    this.send({ type: 'input', payload });
  }

  getPeerScreen() {
    return this.peerInfo?.screen || { width: 1920, height: 1080 };
  }

  /**
   * Local cursor hit a monitor edge → start driving the peer if it matches layout.
   * @param {{ edge: string, displayId: number }} hit
   */
  tryLeaveViaEdge(hit) {
    if (!this.socket || !this.cursorHere) return false;
    const layout = this.getLayout();
    const edge = typeof hit === 'string' ? hit : hit.edge;
    const displayId = typeof hit === 'string' ? null : hit.displayId;

    if (edge !== layout.edge) return false;
    if (layout.displayId != null && displayId != null && displayId !== layout.displayId) {
      return false;
    }

    this.cursorHere = false;
    this.send({ type: 'enter' });
    this.emit('control-enter');
    this.log(`Controlling remote via ${edge} edge — Ctrl+Alt+Backspace to return`);
    return true;
  }

  /** Hotkey: stop driving the remote and bring cursor home. */
  async releaseControl() {
    if (!this.socket) return;
    if (!this.cursorHere) {
      this.cursorHere = true;
      this.send({ type: 'leave' });
      this.emit('control-leave');
      this.log('Returned to local machine');
    } else {
      this.send({ type: 'release' });
    }
  }

  async disconnect() {
    this._closing = true;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    if (this.wss) {
      await new Promise((resolve) => this.wss.close(() => resolve()));
      this.wss = null;
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    this.role = null;
    this.peerInfo = null;
    this.cursorHere = true;
    this.emit('peer', null);
    this.emit('status', { state: 'idle' });
  }
}

module.exports = { PeerHub };
