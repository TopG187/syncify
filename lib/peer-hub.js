const EventEmitter = require('events');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const { normalizeLayout } = require('./layout');

/**
 * Peer hub with sticky session + auto-reconnect.
 * Stays active until the user explicitly disconnects.
 */
class PeerHub extends EventEmitter {
  constructor({ defaultPort, sessionStore }) {
    super();
    this.defaultPort = defaultPort;
    this.sessionStore = sessionStore || null;
    this.server = null;
    this.wss = null;
    this.socket = null;
    this.role = null;
    this.port = defaultPort;
    this.remoteHost = null;
    this.layout = { edge: 'right', displayId: null };
    this.peerInfo = null;
    this.localInfo = {
      name: os.hostname(),
      platform: process.platform,
    };
    this.cursorHere = true;
    /** User wants link alive (not explicit Disconnect) */
    this.wantedActive = false;
    this._closing = false;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._connecting = false;
    this._pingTimer = null;
  }

  log(msg) {
    this.emit('log', msg);
  }

  setLayout(layout) {
    this.layout = normalizeLayout(layout, this.layout.displayId);
    this._persistSession();
  }

  getLayout() {
    return normalizeLayout(this.layout);
  }

  getSession() {
    if (!this.wantedActive || !this.role) return null;
    return {
      enabled: true,
      role: this.role,
      host: this.remoteHost,
      port: this.port,
      layout: this.getLayout(),
    };
  }

  _persistSession() {
    if (!this.sessionStore || !this.wantedActive || !this.role) return;
    this.sessionStore.save({
      enabled: true,
      role: this.role,
      host: this.remoteHost,
      port: this.port || this.defaultPort,
      layout: this.getLayout(),
    });
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.ping();
        } catch {
          /* ignore */
        }
      }
    }, 15000);
  }

  async _teardownSocketAndServer() {
    this._closing = true;
    this._stopPing();
    this._clearReconnect();

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
    this.peerInfo = null;
    this.cursorHere = true;
    this._closing = false;
  }

  async host(port, layout) {
    await this._teardownSocketAndServer();
    this.wantedActive = true;
    this.role = 'host';
    this.port = Number(port) || this.defaultPort;
    this.remoteHost = null;
    this.layout = normalizeLayout(layout);
    this.cursorHere = true;
    this._reconnectAttempt = 0;

    this.server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Syncify');
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => {
      // Replace previous peer if any
      if (this.socket && this.socket !== ws) {
        try {
          this.socket.close();
        } catch {
          /* ignore */
        }
      }
      this._bindSocket(ws);
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '0.0.0.0', () => resolve());
    });

    this._persistSession();
    this.emit('status', { state: 'hosting', port: this.port, layout: this.layout, sticky: true });
    this.log(`Hosting on port ${this.port} — stays on until you Disconnect`);
  }

  async connect(host, port, layout) {
    const targetHost = String(host || '').trim();
    const targetPort = Number(port) || this.defaultPort;
    if (!targetHost) throw new Error('Host IP required');

    await this._teardownSocketAndServer();
    this.wantedActive = true;
    this.role = 'client';
    this.remoteHost = targetHost;
    this.port = targetPort;
    if (layout) this.layout = normalizeLayout(layout);
    this.cursorHere = true;
    this._persistSession();

    await this._connectOnce();
  }

  async _connectOnce() {
    if (!this.wantedActive || this.role !== 'client' || this._connecting) return;
    this._connecting = true;
    this._clearReconnect();

    const url = `ws://${this.remoteHost}:${this.port}`;
    this.emit('status', {
      state: 'reconnecting',
      host: this.remoteHost,
      port: this.port,
      attempt: this._reconnectAttempt + 1,
      sticky: true,
    });

    try {
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
      this._reconnectAttempt = 0;
      this.emit('status', {
        state: 'connected',
        host: this.remoteHost,
        port: this.port,
        layout: this.layout,
        sticky: true,
      });
      this.log(`Connected to ${this.remoteHost}:${this.port}`);
    } catch (err) {
      this._reconnectAttempt += 1;
      const delay = Math.min(30000, 1000 * Math.min(20, this._reconnectAttempt));
      this.log(`Waiting for host… retry in ${Math.round(delay / 1000)}s (${err.message})`);
      this.emit('status', {
        state: 'reconnecting',
        host: this.remoteHost,
        port: this.port,
        attempt: this._reconnectAttempt,
        sticky: true,
      });
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        this._connectOnce().catch(() => {});
      }, delay);
    } finally {
      this._connecting = false;
    }
  }

  _scheduleClientReconnect() {
    if (!this.wantedActive || this.role !== 'client') return;
    this._clearReconnect();
    const delay = Math.min(30000, 1000 * Math.max(1, Math.min(10, this._reconnectAttempt + 1)));
    this._reconnectAttempt += 1;
    this.emit('status', {
      state: 'reconnecting',
      host: this.remoteHost,
      port: this.port,
      attempt: this._reconnectAttempt,
      sticky: true,
    });
    this.log(`Peer lost — reconnecting in ${Math.round(delay / 1000)}s…`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connectOnce().catch(() => {});
    }, delay);
  }

  _bindSocket(ws) {
    this.socket = ws;
    this._closing = false;
    this._startPing();

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
      this._stopPing();
      this.socket = null;
      this.peerInfo = null;
      this.emit('peer', null);
      this.log('Peer disconnected');
      if (!this.cursorHere) {
        this.cursorHere = true;
        this.emit('control-leave');
      }

      if (!this.wantedActive) {
        this.emit('status', { state: 'idle' });
        return;
      }

      if (this.role === 'host') {
        this.emit('status', {
          state: 'hosting',
          port: this.port,
          layout: this.layout,
          sticky: true,
          waiting: true,
        });
        this.log('Waiting for peer to come back…');
      } else if (this.role === 'client') {
        this._scheduleClientReconnect();
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
        this.emit('status', { state: 'paired', layout: this.layout, sticky: true });
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
        this.emit('remote-input', msg.payload);
        break;
      case 'enter':
        this.log(`${this.peerInfo?.name || 'Peer'} is controlling this machine`);
        this.emit('status', { state: 'paired', beingControlled: true, layout: this.layout, sticky: true });
        break;
      case 'leave':
        this.log('Peer returned to their machine');
        this.emit('status', { state: 'paired', beingControlled: false, layout: this.layout, sticky: true });
        break;
      case 'release':
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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    // Cap huge pastes so we do not stall the socket (512 KB text)
    let payload = text == null ? '' : String(text);
    if (payload.length > 512 * 1024) {
      payload = payload.slice(0, 512 * 1024);
      this.log('Clipboard truncated (too large)');
    }
    this.send({ type: 'clipboard', text: payload });
    return true;
  }

  sendInput(payload) {
    if (!this.socket || this.cursorHere) return;
    this.send({ type: 'input', payload });
  }

  getPeerScreen() {
    return this.peerInfo?.screen || { width: 1920, height: 1080 };
  }

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

  /** Explicit user Disconnect — stop auto-reconnect and clear session. */
  async disconnect() {
    this.wantedActive = false;
    this._clearReconnect();
    this._stopPing();
    if (this.sessionStore) this.sessionStore.clear();
    await this._teardownSocketAndServer();
    this.role = null;
    this.remoteHost = null;
    this.emit('peer', null);
    this.emit('status', { state: 'idle' });
    this.log('Disconnected — auto-reconnect off');
  }

  /** App quit: close sockets but keep session file for next launch. */
  async shutdown() {
    this.wantedActive = false;
    this._clearReconnect();
    this._stopPing();
    await this._teardownSocketAndServer();
    this.role = null;
  }

  /** Resume saved session after app start / reboot. */
  async restoreSession() {
    if (!this.sessionStore) return false;
    const session = this.sessionStore.load();
    if (!session) return false;

    this.layout = normalizeLayout(session.layout);
    this.log('Restoring last connection…');

    try {
      if (session.role === 'host') {
        await this.host(session.port || this.defaultPort, session.layout);
        return true;
      }
      if (session.role === 'client' && session.host) {
        // connect() already retries forever while wantedActive
        this.wantedActive = true;
        this.role = 'client';
        this.remoteHost = session.host;
        this.port = session.port || this.defaultPort;
        this._persistSession();
        this._connectOnce().catch(() => {});
        return true;
      }
    } catch (err) {
      this.log(`Restore failed: ${err.message} — will keep trying`);
      if (session.role === 'client' && session.host) {
        this.wantedActive = true;
        this.role = 'client';
        this.remoteHost = session.host;
        this.port = session.port || this.defaultPort;
        this._scheduleClientReconnect();
        return true;
      }
      if (session.role === 'host') {
        // Retry host shortly (port busy etc.)
        this.wantedActive = true;
        setTimeout(() => {
          this.host(session.port || this.defaultPort, session.layout).catch((e) => {
            this.log(`Host retry failed: ${e.message}`);
          });
        }, 2000);
        return true;
      }
    }
    return false;
  }
}

module.exports = { PeerHub };
