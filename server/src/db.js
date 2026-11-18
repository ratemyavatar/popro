'use strict';
// Tiny JSON-file datastore. Each collection is a plain object kept in memory and
// flushed to disk (atomically) a moment after it changes. Fine for a community-sized server.
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cols = {};
    this.dirty = new Set();
    this.timer = null;
    process.on('exit', () => this.flushSync());
  }
  col(name) {
    if (!this.cols[name]) {
      const file = path.join(this.dir, name + '.json');
      let data = {};
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* new collection */ }
      this.cols[name] = data;
    }
    return this.cols[name];
  }
  touch(name) {
    this.dirty.add(name);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flushSync(); }, 500);
  }
  flushSync() {
    for (const name of this.dirty) {
      const file = path.join(this.dir, name + '.json');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.cols[name]));
      fs.renameSync(tmp, file);
    }
    this.dirty.clear();
  }
}

module.exports = { Store };
