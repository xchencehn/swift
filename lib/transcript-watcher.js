'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Observe only archives requested by chat viewers. Bound both the lifetime and
// count so closing a page cannot leave every past session under observation.
class TranscriptWatcher {
  constructor(onChange, { interval = 300, ttl = 60000, maxFiles = 64 } = {}) {
    this.onChange = onChange;
    this.interval = interval;
    this.ttl = ttl;
    this.maxFiles = maxFiles;
    this.files = new Map();
    this.directories = new Map();
    this.timer = setInterval(() => this.prune(), Math.min(ttl, 15000));
    this.timer.unref();
  }
  watch(file) {
    const existing = this.files.get(file);
    if (existing) {
      existing.touched = Date.now();
      this.watchDirectory(file);
      return;
    }
    this.prune();
    if (this.files.size >= this.maxFiles) {
      const oldest = [...this.files].sort((a, b) => a[1].touched - b[1].touched)[0];
      this.remove(oldest[0]);
    }
    const entry = { touched: Date.now(), signature: null, reading: false, again: false };
    const observe = (stat, notify) => {
      if (this.files.get(file) !== entry) return;
      const signature = stat
        ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        : 'missing';
      if (entry.signature === signature) return;
      const initialized = entry.signature !== null;
      entry.signature = signature;
      if (initialized || notify) this.onChange(file);
    };
    entry.listener = (current) => observe(current.ino ? current : null, false);
    entry.check = (notify = true) => {
      if (entry.reading) {
        entry.again = true;
        return;
      }
      entry.reading = true;
      fs.stat(file, (error, stat) => {
        entry.reading = false;
        if (this.files.get(file) !== entry) return;
        if (!error || error.code === 'ENOENT') observe(error ? null : stat, notify);
        if (entry.again) {
          entry.again = false;
          entry.check();
        }
      });
    };
    this.files.set(file, entry);
    // Directory watches survive archive replacement and notice a newly created
    // file. Polling remains a fallback for filesystems without notifications.
    this.watchDirectory(file);
    fs.watchFile(file, { persistent: false, interval: this.interval }, entry.listener);
    entry.check(false);
  }
  watchDirectory(file) {
    const directory = path.dirname(file);
    let parent = this.directories.get(directory);
    if (!parent) {
      parent = { files: new Set(), watcher: null };
      this.directories.set(directory, parent);
    }
    parent.files.add(file);
    if (parent.watcher) return;
    try {
      const watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
        for (const target of parent.files) {
          if (name == null || String(name) === path.basename(target))
            this.files.get(target)?.check();
        }
      });
      parent.watcher = watcher;
      watcher.on('error', () => {
        watcher.close();
        if (parent.watcher === watcher) parent.watcher = null;
      });
    } catch {
      /* Missing directories and unsupported filesystems use watchFile. */
    }
  }
  remove(file) {
    const entry = this.files.get(file);
    if (!entry) return;
    fs.unwatchFile(file, entry.listener);
    this.files.delete(file);
    const directory = path.dirname(file),
      parent = this.directories.get(directory);
    parent?.files.delete(file);
    if (parent && !parent.files.size) {
      parent.watcher?.close();
      this.directories.delete(directory);
    }
  }
  prune() {
    for (const [file, entry] of this.files)
      if (Date.now() - entry.touched >= this.ttl) this.remove(file);
  }
  close() {
    clearInterval(this.timer);
    for (const file of this.files.keys()) this.remove(file);
  }
}
module.exports = { TranscriptWatcher };
