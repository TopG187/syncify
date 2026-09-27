const fs = require('fs');
const path = require('path');

/**
 * Persists last connection so Syncify can resume after sleep / reboot
 * until the user explicitly clicks Disconnect.
 */
class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (!data || data.enabled !== true) return null;
      if (data.role !== 'host' && data.role !== 'client') return null;
      return data;
    } catch {
      return null;
    }
  }

  save(session) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(session, null, 2), 'utf8');
  }

  clear() {
    try {
      if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
    } catch {
      /* ignore */
    }
  }
}

module.exports = { SessionStore };
