'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RootData, readJson, writeJson } = require('../lib/root-data');
const { RootSettings } = require('../lib/root-settings');
const { RootState } = require('../lib/root-state');
const scope = { session: 'test-root', endpoint: 'ws://fixture' };
function setup(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-root-data-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const a = path.join(temp, 'a'),
    b = path.join(temp, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  return { temp, a, b };
}
test('根目录初始化完整存储结构，重启和切回后按设备恢复配置', (t) => {
  const { temp, a, b } = setup(t),
    bootstrap = path.join(temp, 'bootstrap.json');
  const settings = new RootSettings({ directory: a, file: bootstrap }),
    first = new RootState(settings.data, scope);
  for (const dir of ['state', 'cache', 'attachments', 'skills', 'workflows', 'devices'])
    assert(fs.statSync(path.join(a, '.agent-studio', dir)).isDirectory());
  first.data.saveConfig({ workflows: { selected: 'build' } });
  fs.writeFileSync(first.data.file('skills/review.md'), 'skill');
  first.data.saveDeviceSettings('phone', { theme: 'light', fontSize: 18 });
  first.data.saveDeviceSettings('desktop', {
    theme: 'black',
    fontSize: 13,
    ui: { studioSidebarWidth: '300' },
  });
  settings.update(b);
  const second = new RootState(settings.data, scope);
  assert.equal(second.data.deviceSettings('phone').fontSize, 14);
  second.data.saveDeviceSettings('phone', { theme: 'soft', fontSize: 16 });
  settings.update(a);
  const restarted = new RootSettings({ directory: b, file: bootstrap }),
    restored = new RootState(restarted.data, scope);
  assert.equal(restored.data.deviceSettings('phone').fontSize, 18);
  assert.equal(restored.data.deviceSettings('desktop').theme, 'black');
  assert.equal(restored.data.config.workflows.selected, 'build');
  assert.equal(fs.readFileSync(restored.data.file('skills/review.md'), 'utf8'), 'skill');
  assert.equal(fs.statSync(restored.data.file('devices/phone.json')).mode & 0o777, 0o600);
});
test('模式宽度从旧设备配置恢复，分别修改并在重启后保持独立', (t) => {
  const { a, b } = setup(t),
    data = new RootData(a);
  writeJson(data.file('devices/desktop.json'), {
    version: 1,
    settings: { ui: { swiftContentWidth: '700' } },
  });
  const migrated = data.deviceSettings('desktop').ui;
  assert.equal(migrated.studioContentWidth, '700');
  assert.equal(migrated.studioTerminalContentWidth, '700');
  data.saveDeviceSettings('desktop', { ui: { studioContentWidth: '900' } });
  data.saveDeviceSettings('desktop', {
    ui: { studioTerminalContentWidth: '540', studioSettingsContentWidth: '820' },
  });
  const restored = new RootData(a).deviceSettings('desktop').ui;
  assert.equal(restored.studioContentWidth, '900');
  assert.equal(restored.studioTerminalContentWidth, '540');
  assert.equal(restored.studioSettingsContentWidth, '820');
  assert.equal(new RootData(b).deviceSettings('desktop').ui.studioSettingsContentWidth, undefined);
  assert.equal(data.deviceSettings('phone').ui.studioTerminalContentWidth, undefined);
  const firstChat = data.saveDeviceSettings('fresh', { ui: { studioContentWidth: '500' } }).ui;
  assert.equal(
    firstChat.studioTerminalContentWidth,
    'auto',
    'First chat adjustment must preserve the responsive terminal width',
  );
});
test('配置文件损坏或符号链接不会覆盖已有根目录数据', (t) => {
  const { temp, a, b } = setup(t);
  const settings = new RootSettings({ directory: a, file: path.join(temp, 'bootstrap.json') });
  fs.symlinkSync(settings.data.path, path.join(b, '.agent-studio'));
  assert.throws(() => settings.update(b), { code: 'INVALID_ROOT_DATA' });
  assert.equal(settings.directory, a);
  fs.unlinkSync(path.join(b, '.agent-studio'));
  const bad = new RootData(b);
  fs.writeFileSync(bad.configFile, 'not json');
  assert.throws(() => settings.update(b));
  assert.equal(settings.directory, a);
  const deviceFile = settings.data.file('devices/broken.json');
  fs.writeFileSync(deviceFile, 'bad');
  assert.throws(() => settings.data.deviceSettings('broken'));
  assert.equal(fs.readFileSync(deviceFile, 'utf8'), 'bad');
  assert.throws(() => settings.data.saveDeviceSettings('../outside', { theme: 'light' }));
});
test('根目录解析缓存只保存该目录的索引，重启复用后继续检查原生存档变化', async (t) => {
  const { temp, a, b } = setup(t),
    data = new RootData(a),
    state = new RootState(data, scope);
  const native = path.join(temp, 'native.jsonl');
  fs.writeFileSync(
    native,
    JSON.stringify({ type: 'user', cwd: a, message: { role: 'user', content: '旧标题' } }) + '\n',
  );
  const entry = await state.history.readArchive(native, 'claude', 'session');
  state.history.discover = async () => [
    entry,
    { provider: 'claude', sessionId: 'outside', cwd: b },
  ];
  await state.history.scan();
  const saved = readJson(data.file('cache/session-index.json'));
  assert.equal(saved.files.length, 1);
  assert.equal(saved.files[0][1].entry.cwd, a);
  const next = new RootState(new RootData(a), scope);
  assert.equal(next.history.cache.size, 1);
  fs.appendFileSync(native, JSON.stringify({ type: 'custom-title', customTitle: '新标题' }) + '\n');
  assert.equal((await next.history.readArchive(native, 'claude', 'session')).title, '新标题');
});

test('项目内集中存储按根目录隔离，重启和切换不在工作根目录创建数据', (t) => {
  const { temp, a, b } = setup(t);
  const storageDirectory = path.join(temp, 'swift-local', 'roots');
  const file = path.join(temp, 'bootstrap.json');
  const settings = new RootSettings({ directory: a, file, storageDirectory });
  const first = settings.data.path;
  settings.data.saveDeviceSettings('phone', { fontSize: 18 });
  settings.update(b);
  assert.notEqual(settings.data.path, first);
  assert.equal(settings.data.deviceSettings('phone').fontSize, 14);
  settings.update(a);
  const restored = new RootSettings({ directory: b, file, storageDirectory });
  assert.equal(restored.data.path, first);
  assert.equal(restored.data.deviceSettings('phone').fontSize, 18);
  assert.equal(fs.existsSync(path.join(a, '.agent-studio')), false);
  assert.equal(fs.existsSync(path.join(b, '.agent-studio')), false);
  assert.equal(fs.statSync(first).mode & 0o777, 0o700);
});

test('集中存储复用已迁入的数据并拒绝数据目录符号链接', (t) => {
  const { temp, a } = setup(t);
  const storageDirectory = path.join(temp, 'roots');
  const original = new RootData(a, { storageDirectory });
  original.saveConfig({ profile: { name: '保留的资料' } });
  const restored = new RootData(a, { storageDirectory });
  assert.equal(restored.config.profile.name, '保留的资料');
  const moved = restored.path + '-moved';
  fs.renameSync(restored.path, moved);
  fs.symlinkSync(moved, restored.path);
  assert.throws(() => new RootData(a, { storageDirectory }), { code: 'INVALID_ROOT_DATA' });
});
