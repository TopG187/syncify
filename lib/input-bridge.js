const { hideCursor, showCursor, forceShowCursor } = require('./cursor-hide');

/**
 * Captures local input when driving the remote machine, injects when being driven.
 */
class InputBridge {
  constructor({
    getDisplays,
    getCursor,
    onLocalInput,
    onEdgeLeave,
    onLocalReclaim,
    isControllingRemote,
    isBeingControlled,
    getPeerScreen,
    getLayout,
  }) {
    this.getDisplays = getDisplays;
    this.getCursor = getCursor;
    this.onLocalInput = onLocalInput;
    this.onEdgeLeave = onEdgeLeave;
    this.onLocalReclaim = onLocalReclaim || (() => {});
    this.isControllingRemote = isControllingRemote;
    this.isBeingControlled = isBeingControlled || (() => false);
    this.getPeerScreen = getPeerScreen;
    this.getLayout = getLayout || (() => ({ edge: 'right', displayId: null }));

    this._capturing = false;
    this._guarding = false;
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
    this._edgeHoldMs = 0;
    this._edgeHoldEdge = null;
    this._ignoreHookUntil = 0;
    this._lastMoveSentAt = 0;
    this._lastInjectX = null;
    this._lastInjectY = null;
    this._lastInjectAt = 0;
    this._injecting = false;
    this._blockRemoteUntil = 0;
    this._accumDx = 0;
    this._accumDy = 0;

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

  /** Hard-block remote mouse/keyboard for a while (emergency stop). */
  blockRemote(ms = 15000) {
    if (ms <= 0) {
      this._blockRemoteUntil = 0;
      return;
    }
    this._blockRemoteUntil = Date.now() + ms;
    this._lastInjectX = null;
    this._lastInjectY = null;
  }

  remoteBlocked() {
    return Date.now() < this._blockRemoteUntil;
  }

  startEdgeWatch() {
    this.stopEdgeWatch();
    this._edgeHoldMs = 0;
    this._edgeHoldEdge = null;
    this._edgeTimer = setInterval(() => this._checkEdge(), 40);
  }

  stopEdgeWatch() {
    if (this._edgeTimer) {
      clearInterval(this._edgeTimer);
      this._edgeTimer = null;
    }
    this._edgeHoldMs = 0;
    this._edgeHoldEdge = null;
  }

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
    const m = 80;
    let nx = pos.x;
    let ny = pos.y;
    if (edge === 'right') nx = Math.min(pos.x, x + width - m);
    if (edge === 'left') nx = Math.max(pos.x, x + m);
    if (edge === 'bottom') ny = Math.min(pos.y, y + height - m);
    if (edge === 'top') ny = Math.max(pos.y, y + m);
    this._edgeCooldownUntil = Date.now() + 1200;
    try {
      const { mouse, Point } = this._nut;
      await mouse.setPosition(new Point(Math.round(nx), Math.round(ny)));
    } catch {
      /* ignore */
    }
  }

  _checkEdge() {
    if (this.isControllingRemote() || this.isBeingControlled() || !this._ready) return;
    if (this._injecting || this.remoteBlocked()) return;
    if (Date.now() < this._edgeCooldownUntil) return;

    const layout = this.getLayout();
    const displays = this.getDisplays();
    if (!displays.length) return;

    const target =
      (layout.displayId != null && displays.find((d) => d.id === layout.displayId)) || null;

    const pos = this.getCursor();
    const margin = 2;

    let edge = null;
    let displayId = null;

    if (target) {
      const { x, y, width, height } = target.bounds;
      const onDisplay =
        pos.x >= x - margin &&
        pos.x <= x + width + margin &&
        pos.y >= y - margin &&
        pos.y <= y + height + margin;
      if (!onDisplay) {
        this._edgeHoldMs = 0;
        this._edgeHoldEdge = null;
        return;
      }
      if (layout.edge === 'left' && pos.x <= x + margin) edge = 'left';
      else if (layout.edge === 'right' && pos.x >= x + width - 1 - margin) edge = 'right';
      else if (layout.edge === 'top' && pos.y <= y + margin) edge = 'top';
      else if (layout.edge === 'bottom' && pos.y >= y + height - 1 - margin) edge = 'bottom';
      displayId = target.id;
    } else {
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
      if (layout.edge === 'left' && pos.x <= minX + margin) edge = 'left';
      else if (layout.edge === 'right' && pos.x >= maxX - 1 - margin) edge = 'right';
      else if (layout.edge === 'top' && pos.y <= minY + margin) edge = 'top';
      else if (layout.edge === 'bottom' && pos.y >= maxY - 1 - margin) edge = 'bottom';
      const d =
        displays.find(
          (disp) =>
            pos.x >= disp.bounds.x &&
            pos.x < disp.bounds.x + disp.bounds.width &&
            pos.y >= disp.bounds.y &&
            pos.y < disp.bounds.y + disp.bounds.height
        ) || displays[0];
      displayId = d.id;
    }

    if (!edge) {
      this._edgeHoldMs = 0;
      this._edgeHoldEdge = null;
      return;
    }

    // Must stay on the edge briefly — prevents accidental hops / feedback
    if (this._edgeHoldEdge !== edge) {
      this._edgeHoldEdge = edge;
      this._edgeHoldMs = 0;
    }
    this._edgeHoldMs += 40;
    if (this._edgeHoldMs >= 180) {
      this._edgeHoldMs = 0;
      this._edgeHoldEdge = null;
      this.onEdgeLeave({ edge, displayId });
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

  async _warpLocalQuiet() {
    const now = Date.now();
    if (now - (this._lastWarpAt || 0) < 280) return;
    this._lastWarpAt = now;
    const c = this._primaryCenter();
    this._ignoreHookUntil = now + 200;
    try {
      await this._nut.mouse.setPosition(new this._nut.Point(c.x, c.y));
      this._lastHookX = c.x;
      this._lastHookY = c.y;
    } catch {
      /* ignore */
    }
    this._ignoreHookUntil = Date.now() + 200;
    this._accumDx = 0;
    this._accumDy = 0;
  }

  async startCapturing() {
    if (!this._ready || this._capturing) return;
    await this.stopGuard();
    this._capturing = true;
    this.stopEdgeWatch();

    const peer = typeof this.getPeerScreen === 'function' ? this.getPeerScreen() : null;
    const screenSize = peer || { width: 1920, height: 1080 };
    this._remoteX = Math.floor(screenSize.width / 2);
    this._remoteY = Math.floor(screenSize.height / 2);
    this._lastHookX = null;
    this._lastHookY = null;
    this._accumDx = 0;
    this._accumDy = 0;
    this._lastWarpAt = 0;

    await this._warpLocalQuiet();
    hideCursor();

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
      const dx = e.x - this._lastHookX;
      const dy = e.y - this._lastHookY;
      this._lastHookX = e.x;
      this._lastHookY = e.y;
      if (!dx && !dy) return;

      // Drop warps / multi-monitor jumps (never treat as real motion)
      if (Math.abs(dx) > 40 || Math.abs(dy) > 40) {
        this._lastHookX = e.x;
        this._lastHookY = e.y;
        return;
      }

      this._accumDx += dx;
      this._accumDy += dy;

      // Ignore tiny jitter
      if (Math.abs(this._accumDx) < 2 && Math.abs(this._accumDy) < 2) return;

      const useDx = this._accumDx;
      const useDy = this._accumDy;
      this._accumDx = 0;
      this._accumDy = 0;

      this._remoteX = Math.max(0, Math.min(screenSize.width - 1, this._remoteX + useDx));
      this._remoteY = Math.max(0, Math.min(screenSize.height - 1, this._remoteY + useDy));

      const now = Date.now();
      if (now - this._lastMoveSentAt >= 16) {
        this._lastMoveSentAt = now;
        this.onLocalInput({
          t: 'move',
          x: Math.round(this._remoteX),
          y: Math.round(this._remoteY),
        });
      }

      // Only re-center at the TRUE outer pixel edge (not a wide zone — that caused skipping)
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
      const atOuter =
        e.x <= minX + 1 || e.x >= maxX - 2 || e.y <= minY + 1 || e.y >= maxY - 2;
      if (atOuter) this._warpLocalQuiet();
    };

    this._onClick = (e) => {
      if (!this._capturing) return;
      this.onLocalInput({ t: 'down', button: this._hookButtonName(e.button) });
    };

    this._onRelease = (e) => {
      if (!this._capturing) return;
      this.onLocalInput({ t: 'up', button: this._hookButtonName(e.button) });
    };

    this._onWheel = (e) => {
      if (!this._capturing) return;
      // uiohook: rotation is typically ±1 per notch; amount is often 3
      const rotation = typeof e.rotation === 'number' ? e.rotation : 0;
      const amount = typeof e.amount === 'number' ? e.amount : 0;
      let dy = rotation !== 0 ? rotation : amount;
      if (!dy) return;
      // Amplify so remote scroll feels normal (nut steps are tiny)
      this.onLocalInput({ t: 'wheel', dy: dy * 6 });
    };

    this._onKeyDown = (e) => {
      if (!this._capturing) return;
      this._updateMods(e, true);
      if (this._mods.ctrl && this._mods.alt && e.keycode === UiohookKey.Backspace) {
        this.onLocalInput({ t: 'hotkey-release' });
        return;
      }
      this.onLocalInput({ t: 'key', down: true, keycode: e.keycode });
    };

    this._onKeyUp = (e) => {
      if (!this._capturing) return;
      this._updateMods(e, false);
      this.onLocalInput({ t: 'key', down: false, keycode: e.keycode });
    };

    uIOhook.on('mousemove', this._onMove);
    uIOhook.on('mousedown', this._onClick);
    uIOhook.on('mouseup', this._onRelease);
    uIOhook.on('wheel', this._onWheel);
    uIOhook.on('keydown', this._onKeyDown);
    uIOhook.on('keyup', this._onKeyUp);
    uIOhook.start();
  }

  async stopCapturing() {
    if (!this._capturing) return;
    this._capturing = false;
    showCursor();
    forceShowCursor();
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
  }

  /** uiohook button → name. 1=left, 2=right, 3=middle (0 also left on some builds). */
  _hookButtonName(button) {
    const b = Number(button);
    if (b === 2) return 'right';
    if (b === 3) return 'middle';
    return 'left'; // 0, 1, or unknown → primary click
  }

  _libnutButton(name) {
    if (name === 'right') return 'right';
    if (name === 'middle') return 'middle';
    return 'left';
  }

  /**
   * While peer controls us, watch for the user grabbing their own mouse.
   * Only reclaim on clear physical movement — NEVER on clicks (injected clicks
   * look identical and were killing control instantly).
   */
  async startGuard() {
    if (!this._ready || this._guarding || this._capturing) return;
    this._guarding = true;
    const { uIOhook } = this._uiohook;

    this._guardMove = (e) => {
      if (!this.isBeingControlled()) return;
      if (this._injecting || Date.now() < (this._suppressGuardUntil || 0)) return;
      if (this.remoteBlocked()) return;
      if (this._lastInjectX == null) return;
      // Must be well after last inject, and clearly away from injected position
      if (Date.now() - this._lastInjectAt < 400) return;
      const dist = Math.hypot(e.x - this._lastInjectX, e.y - this._lastInjectY);
      if (dist > 120) {
        this.onLocalReclaim();
      }
    };

    uIOhook.on('mousemove', this._guardMove);
    try {
      uIOhook.start();
    } catch {
      /* may already be running */
    }
  }

  async stopGuard() {
    if (!this._guarding || !this._uiohook) {
      this._guarding = false;
      return;
    }
    this._guarding = false;
    const { uIOhook } = this._uiohook;
    try {
      if (this._guardMove) uIOhook.off('mousemove', this._guardMove);
      if (this._guardClick) uIOhook.off('mousedown', this._guardClick);
      if (!this._capturing) uIOhook.stop();
    } catch {
      /* ignore */
    }
    this._guardClick = null;
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
    if (this.isControllingRemote()) return;
    if (!this.isBeingControlled()) return;
    if (this.remoteBlocked()) return;

    const { mouse, keyboard, Point } = this._nut;
    let libnut = null;
    try {
      libnut = require('@nut-tree-fork/libnut');
    } catch {
      /* fall back to nut mouse */
    }

    try {
      this._injecting = true;
      this._suppressGuardUntil = Date.now() + 500;
      this._edgeCooldownUntil = Date.now() + 500;
      switch (msg.t) {
        case 'move': {
          const x = Math.round(msg.x);
          const y = Math.round(msg.y);
          if (this._lastInjectX === x && this._lastInjectY === y) break;
          this._lastInjectX = x;
          this._lastInjectY = y;
          this._lastInjectAt = Date.now();
          await mouse.setPosition(new Point(x, y));
          break;
        }
        case 'down': {
          this._lastInjectAt = Date.now();
          const btn = this._libnutButton(msg.button);
          // Use libnut strings directly — avoids Button enum mixups (left/right swap)
          if (libnut && typeof libnut.mouseToggle === 'function') {
            libnut.mouseToggle('down', btn);
          } else {
            const { Button } = this._nut;
            await mouse.pressButton(btn === 'right' ? Button.RIGHT : btn === 'middle' ? Button.MIDDLE : Button.LEFT);
          }
          break;
        }
        case 'up': {
          this._lastInjectAt = Date.now();
          const btn = this._libnutButton(msg.button);
          if (libnut && typeof libnut.mouseToggle === 'function') {
            libnut.mouseToggle('up', btn);
          } else {
            const { Button } = this._nut;
            await mouse.releaseButton(btn === 'right' ? Button.RIGHT : btn === 'middle' ? Button.MIDDLE : Button.LEFT);
          }
          break;
        }
        case 'wheel': {
          // Stronger scroll — each notch should feel like a normal OS wheel step
          const raw = Number(msg.dy) || 0;
          if (!raw) break;
          const steps = Math.max(3, Math.min(24, Math.abs(raw)));
          if (raw > 0) await mouse.scrollDown(steps);
          else await mouse.scrollUp(steps);
          break;
        }
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
      this._suppressGuardUntil = Date.now() + 500;
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
