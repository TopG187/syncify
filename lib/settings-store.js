const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  mouseShareEnabled: true,
};

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._data = { ...DEFAULTS };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      this._data = { ...DEFAULTS, ...data };
    } catch {
      this._data = { ...DEFAULTS };
    }
    return this._data;
  }

  get() {
    return { ...this._data };
  }

  set(partial) {
    this._data = { ...this._data, ...partial };
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2), 'utf8');
    return this._data;
  }
}

module.exports = { SettingsStore, DEFAULTS };
