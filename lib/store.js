'use strict';

/**
 * Tiny JSON-file store. The whole dataset lives in memory and is written back
 * atomically (tmp file + rename) on every change, so a crash mid-write can never
 * leave a half-written items.json behind. Plenty for a hand-curated feed.
 */

const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, fallback) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err.message}`);
      this.data = fallback;
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
