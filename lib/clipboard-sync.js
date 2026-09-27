/**
 * Polls the system clipboard and pushes changes to the peer.
 * Ignores echoes from remote applies to avoid loops.
 */
class ClipboardSync {
  constructor({ getText, setText, onLocalChange, intervalMs = 400 }) {
    this.getText = getText;
    this.setText = setText;
    this.onLocalChange = onLocalChange;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._last = '';
    this._ignore = null;
  }

  start() {
    this._last = this.getText() || '';
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    const text = this.getText() || '';
    if (text === this._last) return;
    if (this._ignore !== null && text === this._ignore) {
      this._last = text;
      this._ignore = null;
      return;
    }
    this._last = text;
    this.onLocalChange(text);
  }

  applyRemote(text) {
    const value = text || '';
    if (value === this._last) return;
    this._ignore = value;
    this._last = value;
    this.setText(value);
  }
}

module.exports = { ClipboardSync };
