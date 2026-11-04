'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { apiError } = require('./message-queue');

function writeJson(file, data) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

class RootData {
  constructor(directory, { storageDirectory } = {}) {
    this.directory = directory;
    this.path = storageDirectory
      ? path.join(
          path.resolve(storageDirectory),
          crypto.createHash('sha256').update(directory).digest('hex'),
        )
      : path.join(directory, '.agent-studio');
    if (!storageDirectory) RootData.migrateLegacy(directory, this.path);
    this.ensureDirectory(this.path);
    for (const name of ['state', 'cache', 'attachments', 'skills', 'workflows', 'devices'])
      this.ensureDirectory(path.join(this.path, name));
    this.configFile = this.file('config.json');
    this.config = readJson(this.configFile, undefined);
    if (this.config === undefined) {
      this.config = { version: 1 };
      writeJson(this.configFile, this.config);
    }
    if (!this.config || this.config.version !== 1)
      throw apiError(400, 'ROOT_DATA_VERSION', '.agent-studio 配置版本不受支持。');
  }
  /**
   * 2026-09-22 之前这里叫 `.swift`。整目录改名一次,里面装着状态库、附件、
   * 设备配置和个人资料 —— 不迁移就等于把历史全丢了。
   *
   * ⚠️ 只在新目录**还不存在**时才搬:两个都在的话说明有人已经处理过,
   * 或者是并行的另一个进程正在建,这时候动手会覆盖掉真正的那一份。
   * 搬不动(跨设备、权限)就原样抛出来 —— 悄悄继续跑会让用户对着一份空状态。
   */
  static migrateLegacy(directory, target) {
    const legacy = path.join(directory, '.swift');
    if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
    if (!fs.statSync(legacy).isDirectory()) return;
    fs.renameSync(legacy, target);
  }

  ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory())
      throw apiError(400, 'INVALID_ROOT_DATA', 'swift 数据目录必须是真实目录。');
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  }
  file(relative) {
    const target = path.resolve(this.path, relative);
    if (!target.startsWith(this.path + path.sep)) throw new Error('Invalid root data path');
    try {
      if (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isFile())
        throw apiError(400, 'INVALID_ROOT_DATA', '.agent-studio 数据文件必须是普通文件。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return target;
  }
  initialize(relative, fallback) {
    const file = this.file(relative);
    if (!fs.existsSync(file)) writeJson(file, fallback);
    return file;
  }
  deviceSettings(id, initialize = true) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid device identity');
    const file = this.file(`devices/${id}.json`);
    const stored = readJson(file, undefined);
    const { mergeSettings } = require('./root-preferences');
    if (stored !== undefined && (!stored || stored.version !== 1))
      throw apiError(400, 'DEVICE_SETTINGS_VERSION', '设备配置版本不受支持。');
    const settings = mergeSettings(stored?.settings, {});
    if (stored === undefined && initialize) writeJson(file, { version: 1, settings });
    return settings;
  }
  saveDeviceSettings(id, patch) {
    const { mergeSettings } = require('./root-preferences');
    const settings = mergeSettings(this.deviceSettings(id), patch);
    writeJson(this.file(`devices/${id}.json`), { version: 1, settings });
    return settings;
  }
  saveConfig(patch) {
    const config = { ...this.config, ...patch, version: 1 };
    writeJson(this.configFile, config);
    this.config = config;
  }
}
module.exports = { RootData, readJson, writeJson };
