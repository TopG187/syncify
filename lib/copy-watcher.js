/**
 * Watches for Copy shortcuts and notifies clipboard sync.
 * Runs independently of mouse-capture hooks.
 */
class CopyWatcher {
  constructor({ onCopy }) {
    this.onCopy = onCopy;
    this._running = false;
    this._uiohook = null;
    this._mods = { ctrl: false, meta: false };
  }

  start() {
    if (this._running) return;
    try {
      this._uiohook = require('uiohook-napi');
    } catch {
      return;
    }
    this._running = true;
    const { uIOhook, UiohookKey } = this._uiohook;

    this._onKeyDown = (e) => {
      const code = e.keycode;
      if (code === UiohookKey.Ctrl || code === UiohookKey.CtrlRight) this._mods.ctrl = true;
      if (code === UiohookKey.Meta || code === UiohookKey.MetaRight) this._mods.meta = true;

      // C key — Ctrl+C (Win) or Cmd+C (Mac)
      if (code === UiohookKey.C && (this._mods.ctrl || this._mods.meta || e.ctrlKey || e.metaKey)) {
        try {
          this.onCopy();
        } catch {
          /* ignore */
        }
      }
      // Also common: Ctrl/Cmd+X cut
      if (code === UiohookKey.X && (this._mods.ctrl || this._mods.meta || e.ctrlKey || e.metaKey)) {
        try {
          this.onCopy();
        } catch {
          /* ignore */
        }
      }
    };

    this._onKeyUp = (e) => {
      const code = e.keycode;
      if (code === UiohookKey.Ctrl || code === UiohookKey.CtrlRight) this._mods.ctrl = false;
      if (code === UiohookKey.Meta || code === UiohookKey.MetaRight) this._mods.meta = false;
    };

    uIOhook.on('keydown', this._onKeyDown);
    uIOhook.on('keyup', this._onKeyUp);
    try {
      uIOhook.start();
    } catch {
      /* may already be started by input bridge */
    }
  }

  stop() {
    if (!this._running || !this._uiohook) return;
    this._running = false;
    const { uIOhook } = this._uiohook;
    try {
      uIOhook.off('keydown', this._onKeyDown);
      uIOhook.off('keyup', this._onKeyUp);
    } catch {
      /* ignore */
    }
  }
}

module.exports = { CopyWatcher };
