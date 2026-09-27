/**
 * Syncs text clipboard between peers.
 * Avoids clear-before-write (that briefly syncs "" and wipes the peer).
 */
class ClipboardSync {
  constructor({ getText, setText, onLocalChange, intervalMs = 150 }) {
    this.getText = getText;
    this.setText = setText;
    this.onLocalChange = onLocalChange;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._lastSent = null; // null = not initialized
    this._lastApplied = null;
    this._ignoreUntil = 0;
    this._paused = false;
    this._enabled = true;
  }

  start() {
    try {
      this._lastSent = this._read();
      this._lastApplied = this._lastSent;
    } catch {
      this._lastSent = '';
      this._lastApplied = '';
    }
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
    try {
      this._lastSent = this._read();
    } catch {
      /* ignore */
    }
  }

  _read() {
    try {
      const t = this.getText();
      return t == null ? '' : String(t);
    } catch {
      return '';
    }
  }

  _write(value) {
    try {
      this.setText(value == null ? '' : String(value));
      return true;
    } catch (err) {
      console.warn('clipboard write failed:', err.message);
      return false;
    }
  }

  _tick() {
    if (!this._enabled || this._paused) return;
    if (Date.now() < this._ignoreUntil) return;

    const text = this._read();
    if (this._lastSent !== null && text === this._lastSent) return;

    this._lastSent = text;
    try {
      this.onLocalChange(text);
    } catch (err) {
      console.warn('clipboard push failed:', err.message);
    }
  }

  /** Apply clipboard text received from the peer. */
  applyRemote(text) {
    const value = text == null ? '' : String(text);

    // Pause polling so we never broadcast a mid-write empty clipboard
    this._paused = true;
    this._ignoreUntil = Date.now() + 1200;
    this._lastApplied = value;
    this._lastSent = value;

    this._write(value);

    // Verify / retry — macOS pasteboard can lag
    setTimeout(() => {
      const now = this._read();
      if (now !== value) {
        this._write(value);
      }
      this._lastSent = this._read();
      this._lastApplied = value;
      this._ignoreUntil = Date.now() + 400;
      this._paused = false;
    }, 100);
  }

  /** Push current clipboard to peer (edge hop / pair / after Copy). */
  flush(force = false) {
    const text = this._read();
    if (!force && this._lastSent !== null && text === this._lastSent) {
      // Still push once so peer gets it even if we think we already sent
      try {
        this.onLocalChange(text);
      } catch {
        /* ignore */
      }
      return text;
    }
    this._lastSent = text;
    try {
      this.onLocalChange(text);
    } catch (err) {
      console.warn('clipboard flush failed:', err.message);
    }
    return text;
  }

  /** Call after Ctrl/Cmd+C so we sync even if poll is slow. */
  notifyCopy() {
    setTimeout(() => {
      const text = this._read();
      this._lastSent = text;
      try {
        this.onLocalChange(text);
      } catch {
        /* ignore */
      }
    }, 120);
  }
}

module.exports = { ClipboardSync };
