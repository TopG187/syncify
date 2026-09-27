/**
 * Captures local input when driving the remote machine, injects when being driven.
 * Uses uiohook-napi + @nut-tree-fork/nut-js when available.
 */
class InputBridge {
  constructor({
    getDisplays,
    getCursor,
    onLocalInput,
    onEdgeLeave,
    isControllingRemote,
    isBeingControlled,
    getPeerScreen,
    getLayout,
  }) {
    this.getDisplays = getDisplays;
    this.getCursor = getCursor;
    this.onLocalInput = onLocalInput;
    this.onEdgeLeave = onEdgeLeave;
    this.isControllingRemote = isControllingRemote;
    this.isBeingControlled = isBeingControlled || (() => false);
    this.getPeerScreen = getPeerScreen;
    this.getLayout = getLayout || (() => ({ edge: 'right', displayId: null }));

    this._capturing = false;
    this._edgeTimer = null;
    this._uiohook = null;
    this._nut = null;
    this._remoteX = 0;
    this._remoteY = 0;
    this._lastHookX = null;
    this._lastHookY = null;
    this._mods = { alt: false, ctrl: false, shift: false, meta: false };
    this._ready = false;
    this._loadError = null;
    this._edgeCooldownUntil = 0;
    this._ignoreHookUntil = 0;
    this._lastMoveSentAt = 0;
    this._lastInjectX = null;
    this._lastInjectY = null;
    this._injecting = false;

    this._loadNative();
  }

  _loadNative() {
    try {
      this._uiohook = require('uiohook-napi');
      this._nut = require('@nut-tree-fork/nut-js');
      this._nut.mouse.config.autoDelayMs = 0;
      this._nut.keyboard.config.autoDelayMs = 0;
      this._ready = true;
    } catch (err) {
      this._loadError = err;
      this._ready = false;
      console.warn('Syncify native input modules unavailable:', err.message);
    }
  }

  get available() {
    return this._ready;
  }

  get loadError() {
    return this._loadError;
  }

  startEdgeWatch() {
    this.stopEdgeWatch();
    this._edgeTimer = setInterval(() => this._checkEdge(), 50);
  }

  stopEdgeWatch() {
    if (this._edgeTimer) {
      clearInterval(this._edgeTimer);
      this._edgeTimer = null;
    }
  }

  /** Pull cursor inward so we do not immediately hop back to the peer. */
  async nudgeInward(layout) {
    if (!this._ready) return;
    const cfg = typeof layout === 'string' ? { edge: layout } : layout || this.getLayout();
    const edge = cfg.edge || 'right';
    const pos = this.getCursor();
    const displays = this.getDisplays();
    let d = null;
    if (cfg.displayId != null) {
      d = displays.find((disp) => disp.id === cfg.displayId) || null;
    }
    if (!d) {
      d =
        displays.find(
          (disp) =>
            pos.x >= disp.bounds.x &&
            pos.x < disp.bounds.x + disp.bounds.width &&
            pos.y >= disp.bounds.y &&
            pos.y < disp.bounds.y + disp.bounds.height
        ) || displays[0];
    }
    if (!d) return;
    const { x, y, width, height } = d.bounds;
    const m = 60;
    let nx = pos.x;
    let ny = pos.y;
    if (edge === 'right') nx = Math.min(pos.x, x + width - m);
    if (edge === 'left') nx = Math.max(pos.x, x + m);
    if (edge === 'bottom') ny = Math.min(pos.y, y + height - m);
    if (edge === 'top') ny = Math.max(pos.y, y + m);
    this._edgeCooldownUntil = Date.now() + 800;
    try {
      const { mouse, Point } = this._nut;
      await mouse.setPosition(new Point(Math.round(nx), Math.round(ny)));
    } catch {
      /* ignore */
    }
  }

  _checkEdge() {
    if (this.isControllingRemote() || this.isBeingControlled() || !this._ready) return;
    if (this._injecting) return;
    if (Date.now() < this._edgeCooldownUntil) return;

    const layout = this.getLayout();
    const displays = this.getDisplays();
    if (!displays.length) return;

    const target =
      (layout.displayId != null && displays.find((d) => d.id === layout.displayId)) ||
      null;

    const pos = this.getCursor();
    const margin = 4;

    // Prefer the configured monitor; only that monitor's chosen edge triggers a hop
    if (target) {
      const { x, y, width, height } = target.bounds;
      const onDisplay =
        pos.x >= x - margin &&
        pos.x <= x + width + margin &&
        pos.y >= y - margin &&
        pos.y <= y + height + margin;
      if (!onDisplay) return;

      let edge = null;
      if (layout.edge === 'left' && pos.x <= x + margin) edge = 'left';
      else if (layout.edge === 'right' && pos.x >= x + width - 1 - margin) edge = 'right';
      else if (layout.edge === 'top' && pos.y <= y + margin) edge = 'top';
      else if (layout.edge === 'bottom' && pos.y >= y + height - 1 - margin) edge = 'bottom';

      if (edge) this.onEdgeLeave({ edge, displayId: target.id });
      return;
    }

    // Fallback: virtual-desktop outer edges (single-monitor / no display picked)
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const d of displays) {
      const { x, y, width, height } = d.bounds;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    }

    let edge = null;
    if (layout.edge === 'left' && pos.x <= minX + margin) edge = 'left';
    else if (layout.edge === 'right' && pos.x >= maxX - 1 - margin) edge = 'right';
    else if (layout.edge === 'top' && pos.y <= minY + margin) edge = 'top';
    else if (layout.edge === 'bottom' && pos.y >= maxY - 1 - margin) edge = 'bottom';

    if (edge) {
      const d =
        displays.find(
          (disp) =>
            pos.x >= disp.bounds.x &&
            pos.x < disp.bounds.x + disp.bounds.width &&
            pos.y >= disp.bounds.y &&
            pos.y < disp.bounds.y + disp.bounds.height
        ) || displays[0];
      this.onEdgeLeave({ edge, displayId: d.id });
    }
  }

  _primaryCenter() {
    const d = this.getDisplays()[0];
    if (!d) return { x: 400, y: 300 };
    return {
      x: Math.floor(d.bounds.x + d.bounds.width / 2),
      y: Math.floor(d.bounds.y + d.bounds.height / 2),
    };
  }

  async startCapturing() {
    if (!this._ready || this._capturing) return;
    this._capturing = true;
    this.stopEdgeWatch();

    const peer = typeof this.getPeerScreen === 'function' ? this.getPeerScreen() : null;
    const screenSize = peer || { width: 1920, height: 1080 };
    this._screenSize = screenSize;
    this._remoteX = Math.floor(screenSize.width / 2);
    this._remoteY = Math.floor(screenSize.height / 2);
    this._lastHookX = null;
    this._lastHookY = null;

    // Park local cursor in the center so relative motion can continue
    await this._warpLocalQuiet();

    const { uIOhook, UiohookKey } = this._uiohook;

    this._onMove = (e) => {
      if (!this._capturing) return;
      if (Date.now() < this._ignoreHookUntil) {
        this._lastHookX = e.x;
        this._lastHookY = e.y;
        return;
      }
      if (this._lastHookX == null) {
        this._lastHookX = e.x;
        this._lastHookY = e.y;
        return;
      }
      let dx = e.x - this._lastHookX;
      let dy = e.y - this._lastHookY;
      this._lastHookX = e.x;
      this._lastHookY = e.y;
      if (!dx && !dy) return;

      // Ignore huge jumps from OS warps / multi-monitor hops (feedback)
      if (Math.abs(dx) > 80 || Math.abs(dy) > 80) return;

      this._remoteX = Math.max(0, Math.min(screenSize.width - 1, this._remoteX + dx));
      this._remoteY = Math.max(0, Math.min(screenSize.height - 1, this._remoteY + dy));

      const now = Date.now();
      if (now - this._lastMoveSentAt >= 8) {
        this._lastMoveSentAt = now;
        this.onLocalInput({ t: 'move', x: Math.round(this._remoteX), y: Math.round(this._remoteY) });
      }

      // Recenter when near local screen edge so we keep receiving deltas
      const displays = this.getDisplays();
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const d of displays) {
        minX = Math.min(minX, d.bounds.x);
        minY = Math.min(minY, d.bounds.y);
        maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
        maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
      }
      const near =
        e.x <= minX + 50 || e.x >= maxX - 50 || e.y <= minY + 50 || e.y >= maxY - 50;
      if (near) {
        this._warpLocalQuiet();
      }
    };

    this._onClick = (e) => {
      if (!this._capturing) return;
      const button = e.button === 2 ? 'right' : e.button === 3 ? 'middle' : 'left';
      this.onLocalInput({ t: 'down', button });
    };

    this._onRelease = (e) => {
      if (!this._capturing) return;
      const button = e.button === 2 ? 'right' : e.button === 3 ? 'middle' : 'left';
      this.onLocalInput({ t: 'up', button });
    };

    this._onWheel = (e) => {
      if (!this._capturing) return;
      const dy = typeof e.rotation === 'number' ? e.rotation : e.amount || 0;
      this.onLocalInput({ t: 'wheel', dy });
    };

    this._onKeyDown = (e) => {
      if (!this._capturing) return;
      this._updateMods(e, true);
      if (this._mods.ctrl && this._mods.alt && e.keycode === UiohookKey.Backspace) {
        this.onLocalInput({ t: 'hotkey-release' });
        return;
      }
      this.onLocalInput({
        t: 'key',
        down: true,
        keycode: e.keycode,
      });
    };

    this._onKeyUp = (e) => {
      if (!this._capturing) return;
      this._updateMods(e, false);
      this.onLocalInput({
        t: 'key',
        down: false,
        keycode: e.keycode,
      });
    };

    uIOhook.on('mousemove', this._onMove);
    uIOhook.on('mousedown', this._onClick);
    uIOhook.on('mouseup', this._onRelease);
    uIOhook.on('wheel', this._onWheel);
    uIOhook.on('keydown', this._onKeyDown);
    uIOhook.on('keyup', this._onKeyUp);
    uIOhook.start();
  }

  async _warpLocalQuiet() {
    const c = this._primaryCenter();
    this._ignoreHookUntil = Date.now() + 120;
    try {
      await this._nut.mouse.setPosition(new this._nut.Point(c.x, c.y));
      this._lastHookX = c.x;
      this._lastHookY = c.y;
    } catch {
      /* ignore */
    }
    this._ignoreHookUntil = Date.now() + 120;
  }

  async stopCapturing() {
    if (!this._capturing) {
      this.startEdgeWatch();
      return;
    }
    this._capturing = false;
    if (this._uiohook) {
      const { uIOhook } = this._uiohook;
      try {
        uIOhook.off('mousemove', this._onMove);
        uIOhook.off('mousedown', this._onClick);
        uIOhook.off('mouseup', this._onRelease);
        uIOhook.off('wheel', this._onWheel);
        uIOhook.off('keydown', this._onKeyDown);
        uIOhook.off('keyup', this._onKeyUp);
        uIOhook.stop();
      } catch (err) {
        console.warn('uiohook stop:', err.message);
      }
    }
    this.startEdgeWatch();
  }

  _updateMods(e, down) {
    const { UiohookKey } = this._uiohook;
    const code = e.keycode;
    if (code === UiohookKey.Ctrl || code === UiohookKey.CtrlRight) this._mods.ctrl = down;
    if (code === UiohookKey.Alt || code === UiohookKey.AltRight) this._mods.alt = down;
    if (code === UiohookKey.Shift || code === UiohookKey.ShiftRight) this._mods.shift = down;
    if (code === UiohookKey.Meta || code === UiohookKey.MetaRight) this._mods.meta = down;
  }

  async applyRemote(msg) {
    if (!this._ready || !msg) return;
    // Never inject while we are the ones driving the peer (would create a loop)
    if (this.isControllingRemote()) return;
    const { mouse, keyboard, Button, Point } = this._nut;

    try {
      this._injecting = true;
      this._edgeCooldownUntil = Date.now() + 400;
      switch (msg.t) {
        case 'move': {
          const x = Math.round(msg.x);
          const y = Math.round(msg.y);
          if (this._lastInjectX === x && this._lastInjectY === y) break;
          this._lastInjectX = x;
          this._lastInjectY = y;
          await mouse.setPosition(new Point(x, y));
          break;
        }
        case 'down':
          await mouse.pressButton(this._btn(Button, msg.button));
          break;
        case 'up':
          await mouse.releaseButton(this._btn(Button, msg.button));
          break;
        case 'wheel':
          if (msg.dy > 0) await mouse.scrollDown(Math.min(5, Math.abs(msg.dy)));
          else if (msg.dy < 0) await mouse.scrollUp(Math.min(5, Math.abs(msg.dy)));
          break;
        case 'key':
          await this._applyKey(keyboard, msg);
          break;
        default:
          break;
      }
    } catch (err) {
      console.warn('inject failed:', err.message);
    } finally {
      this._injecting = false;
    }
  }

  _btn(Button, name) {
    if (name === 'right') return Button.RIGHT;
    if (name === 'middle') return Button.MIDDLE;
    return Button.LEFT;
  }

  async _applyKey(keyboard, msg) {
    const Key = this._nut.Key;
    const map = this._keyMap(Key);
    const k = map[msg.keycode];
    if (!k) return;
    if (msg.down) await keyboard.pressKey(k);
    else await keyboard.releaseKey(k);
  }

  _keyMap(Key) {
    if (this.__keyMap) return this.__keyMap;
    const { UiohookKey } = this._uiohook;
    const m = {};
    const pairs = [
      ['A', Key.A], ['B', Key.B], ['C', Key.C], ['D', Key.D], ['E', Key.E], ['F', Key.F],
      ['G', Key.G], ['H', Key.H], ['I', Key.I], ['J', Key.J], ['K', Key.K], ['L', Key.L],
      ['M', Key.M], ['N', Key.N], ['O', Key.O], ['P', Key.P], ['Q', Key.Q], ['R', Key.R],
      ['S', Key.S], ['T', Key.T], ['U', Key.U], ['V', Key.V], ['W', Key.W], ['X', Key.X],
      ['Y', Key.Y], ['Z', Key.Z],
      ['Num0', Key.Num0], ['Num1', Key.Num1], ['Num2', Key.Num2], ['Num3', Key.Num3],
      ['Num4', Key.Num4], ['Num5', Key.Num5], ['Num6', Key.Num6], ['Num7', Key.Num7],
      ['Num8', Key.Num8], ['Num9', Key.Num9],
      ['F1', Key.F1], ['F2', Key.F2], ['F3', Key.F3], ['F4', Key.F4],
      ['F5', Key.F5], ['F6', Key.F6], ['F7', Key.F7], ['F8', Key.F8],
      ['F9', Key.F9], ['F10', Key.F10], ['F11', Key.F11], ['F12', Key.F12],
      ['Space', Key.Space], ['Enter', Key.Enter], ['Backspace', Key.Backspace],
      ['Tab', Key.Tab], ['Escape', Key.Escape], ['Delete', Key.Delete],
      ['Up', Key.Up], ['Down', Key.Down], ['Left', Key.Left], ['Right', Key.Right],
      ['Home', Key.Home], ['End', Key.End], ['PageUp', Key.PageUp], ['PageDown', Key.PageDown],
      ['CapsLock', Key.CapsLock],
      ['Ctrl', Key.LeftControl], ['CtrlRight', Key.RightControl],
      ['Alt', Key.LeftAlt], ['AltRight', Key.RightAlt],
      ['Shift', Key.LeftShift], ['ShiftRight', Key.RightShift],
      ['Meta', Key.LeftSuper], ['MetaRight', Key.RightSuper],
      ['Semicolon', Key.Semicolon], ['Equal', Key.Equal], ['Comma', Key.Comma],
      ['Minus', Key.Minus], ['Period', Key.Period], ['Slash', Key.Slash],
      ['Quote', Key.Quote], ['Backslash', Key.Backslash],
      ['Backquote', Key.Grave], ['BracketLeft', Key.LeftBracket], ['BracketRight', Key.RightBracket],
    ];
    for (const [name, nutKey] of pairs) {
      if (UiohookKey[name] != null && nutKey != null) m[UiohookKey[name]] = nutKey;
    }
    this.__keyMap = m;
    return m;
  }
}

module.exports = { InputBridge };
