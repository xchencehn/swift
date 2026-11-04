'use strict';
const { apiError } = require('./message-queue');
const defaults = { theme: 'default', fontSize: 14, terminalFontSize: 0, ui: {} };
// `ui` 这一袋按「根目录 + 设备标识」存（devices/<设备标识>.json），所以放进来的
// 都是**设备本地的视图状态**：折叠了哪些分组、栏宽、哪些会话我已经看过。
// ⚠️ 白名单是硬的：不在表里的键直接 400，免得前端随手往这里塞东西。所以**新增一项
// 界面状态必须登记进来** —— 漏了的表现是「改了有效、刷新就回去」：前端 `storage.set`
// 把那个 400 catch 掉了，不报错也不留痕。
const uiKeys = new Set([
  'studioCollapsedGroups',
  'studioSidebarWidth',
  'studioContentWidth',
  'studioTerminalContentWidth',
  'studioSettingsContentWidth',
  'studioFilesWidth',
  'chat.sidebarCollapsed',
  'studioPrefs',
  'studioSeenDone',
  'studioDocTab',
  'studioFilesMax',
]);
// 2026-09-22 这几个键从 `swift*` 改成 `studio*`。存在设备配置里的旧键要认回来,
// 否则栏宽、折叠状态和「哪些会话我已经看过」会在改名那一刻整片消失。
const renamedUiKeys = new Map([
  ['swiftCollapsedGroups', 'studioCollapsedGroups'],
  ['swiftSidebarWidth', 'studioSidebarWidth'],
  ['swiftContentWidth', 'studioContentWidth'],
  ['swiftPrefs', 'studioPrefs'],
  ['swiftSeenDone', 'studioSeenDone'],
]);
/** 把读出来的那一袋界面状态里的旧键换成新键。新键已经有值时以新键为准。 */
function migrateUi(ui) {
  if (!ui || typeof ui !== 'object') return ui;
  let moved = null;
  for (const [from, to] of renamedUiKeys) {
    if (!(from in ui)) continue;
    moved = moved || { ...ui };
    if (!(to in moved)) moved[to] = ui[from];
    delete moved[from];
  }
  // 旧设备的共享宽度作为两种模式的初始值，之后修改聊天宽度不再改动终端。
  const current = moved || ui;
  if (!('studioTerminalContentWidth' in current) && 'studioContentWidth' in current) {
    moved = { ...current, studioTerminalContentWidth: current.studioContentWidth };
  }
  return moved || ui;
}

function mergeSettings(previous = {}, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw apiError(400, 'INVALID_SETTINGS', '设置必须是对象。');
  for (const key of Object.keys(patch))
    if (!['theme', 'fontSize', 'terminalFontSize', 'ui'].includes(key))
      throw apiError(400, 'INVALID_SETTINGS', '不支持的设置项。');
  if ('theme' in patch && !['default', 'black', 'soft', 'light'].includes(patch.theme))
    throw apiError(400, 'INVALID_SETTINGS', '主题无效。');
  if (
    'fontSize' in patch &&
    (!Number.isInteger(patch.fontSize) || patch.fontSize < 12 || patch.fontSize > 20)
  )
    throw apiError(400, 'INVALID_SETTINGS', '字体大小必须为 12–20。');
  if (
    'terminalFontSize' in patch &&
    !(
      patch.terminalFontSize === 0 ||
      (Number.isFinite(patch.terminalFontSize) &&
        patch.terminalFontSize >= 7 &&
        patch.terminalFontSize <= 24 &&
        Number.isInteger(patch.terminalFontSize * 2))
    )
  )
    throw apiError(400, 'INVALID_SETTINGS', '终端字体大小必须为 7–24，步长为 0.5。');
  if (
    'ui' in patch &&
    (!patch.ui ||
      typeof patch.ui !== 'object' ||
      Array.isArray(patch.ui) ||
      Object.entries(patch.ui).some(
        ([key, value]) => !uiKeys.has(key) || typeof value !== 'string' || value.length > 16384,
      ))
  )
    throw apiError(400, 'INVALID_SETTINGS', '界面设置无效。');
  const ui = { ...migrateUi(previous.ui), ...patch.ui };
  // 首次只调整聊天宽度时，终端继续使用随主区域变化的默认宽度。
  if ('studioContentWidth' in ui && !('studioTerminalContentWidth' in ui))
    ui.studioTerminalContentWidth = 'auto';
  return { ...defaults, ...previous, ...patch, ui };
}
function deviceId(req) {
  // ⚠️ 旧的 `x-swift-device-id` 头与 `swiftDevice` cookie 也要认：认不出来就退回
  // 'default'，等于这台设备的主题、字号、栏宽、已读记录全部换了一份空的。
  const cookie = String(req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim());
  const fromCookie = (name) =>
    cookie.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  const raw =
    req.headers['x-agent-studio-device-id'] ||
    req.headers['x-swift-device-id'] ||
    fromCookie('agentStudioDevice') ||
    fromCookie('swiftDevice') ||
    'default';
  return typeof raw === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(raw) ? raw : 'default';
}
module.exports = { defaults, mergeSettings, deviceId, migrateUi };
