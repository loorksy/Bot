const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.dir = path.dirname(filePath);
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this._data = {};
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this._data = JSON.parse(raw || '{}');
      }
    } catch {
      this._data = {};
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2));
    } catch {}
  }

  get(key, def = undefined) {
    return key in this._data ? this._data[key] : def;
  }

  set(key, val) {
    this._data[key] = val;
    this._save();
  }

  delete(key) {
    delete this._data[key];
    this._save();
  }

  get store() {
    return this._data;
  }
}

module.exports = { JsonStore };
