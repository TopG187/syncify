/**
 * Syncs text clipboard between peers.
 * Polls locally, pushes on change, and flushes on control handoff.
 */
class ClipboardSync {
  constructor({ getText, setText, onLocalChange, intervalMs = 200 }) {
    this.getText = getText;
    this.setText = setText;
    this.onLocalChange = onLocalChange;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._lastSent = '';
    this._lastApplied = '';
    this._ignoreUntil = 0;
    this._enabled = true;
  }

  start() {
    try {
      this._lastSent = this._read() || '';
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

  _read() {
    try {
      return this.getText() || '';
    } catch {
      return '';
    }
  }

  _write(value) {
    try {
      this.setText(value || '');
      return true;
    } catch (err) {
      console.warn('clipboard write failed:', err.message);
      return false;
    }
  }

  _tick() {
    if (!this._enabled) return;
    const text = this._read();
    if (text === this._lastSent) return;

    // Skip echo from a remote write we just applied
    if (Date.now() < this._ignoreUntil && text === this._lastApplied) {
      this._lastSent = text;
      return;
    }

    this._lastSent = text;
    this.onLocalChange(text);
  }

  /** Apply clipboard text received from the peer. */
  applyRemote(text) {
    const value = text == null ? '' : String(text);
    if (value === this._lastApplied && value === this._read()) return;

    this._lastApplied = value;
    this._lastSent = value;
    this._ignoreUntil = Date.now() + 800;
    this._write(value);

    // Re-check shortly — some OS clipboard writes land asynchronously
    setTimeout(() => {
      const now = this._read();
      if (now !== value) {
        this._write(value);
        this._lastSent = value;
        this._lastApplied = value;
        this._ignoreUntil = Date.now() + 800;
      }
    }, 50);
  }

  /** Push current clipboard to peer (e.g. when hopping screens). */
  flush() {
    const text = this._read();
    this._lastSent = text;
    this.onLocalChange(text);
    return text;
  }

  /** Force-send a known string (e.g. after detecting Ctrl/Cmd+C). */
  pushText(text) {
    const value = text == null ? '' : String(text);
    if (!value && value !== '') return;
    // Small delay so the OS finishes updating the clipboard after Copy
    setTimeout(() => {
      const latest = this._read() || value;
      if (latest === this._lastSent && latest === value) {
        // Still push — peer may have missed earlier sync
      }
      this._lastSent = latest;
      this.onLocalChange(latest);
    }, 80);
  }
}

module.exports = { ClipboardSync };
