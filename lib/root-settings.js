'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RootData } = require('./root-data');
const { apiError } = require('./message-queue');

class RootSettings {
  constructor({
    directory,
    storageDirectory,
    file = path.join(os.homedir(), '.local', 'state', 'swift', 'settings.json'),
  }) {
    this.storageDirectory = storageDirectory;
    this.file = file;
    this.directory = path.resolve(directory);
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.directory = this.validate(saved.rootDirectory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(this.directory, { recursive: true });
    }
    this.directory = this.validate(this.directory);
    this.data = new RootData(this.directory, { storageDirectory: this.storageDirectory });
  }
  validate(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value.trim()) || /[\x00-\x1f]/.test(value))
      throw apiError(400, 'INVALID_ROOT_DIRECTORY', '请输入目录的绝对路径。');
    try {
      const directory = fs.realpathSync(value.trim());
      if (!fs.statSync(directory).isDirectory()) throw new Error('not a directory');
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
      return directory;
    } catch {
      throw apiError(400, 'INVALID_ROOT_DIRECTORY', '目录不存在或不可读写，请选择其他目录。');
    }
  }
  prepare(value) {
    return new RootData(this.validate(value), { storageDirectory: this.storageDirectory });
  }
  update(value, prepared = this.prepare(value)) {
    const directory = this.validate(value);
    if (prepared.directory !== directory) throw new Error('Root data directory mismatch');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ rootDirectory: directory }, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.directory = directory;
    this.data = prepared;
    return directory;
  }
}
module.exports = { RootSettings };
