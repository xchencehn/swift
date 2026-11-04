'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { apiError } = require('./message-queue');
async function prepareWorkspace(root, label, directory = root) {
  if (
    typeof label !== 'string' ||
    !label.trim() ||
    /[\x00-\x1f]/.test(label) ||
    Buffer.byteLength(label) > 200
  )
    throw apiError(400, 'INVALID_WORKSPACE_NAME', '请输入有效的工作区名称。');
  if (typeof directory !== 'string' || !path.isAbsolute(directory))
    throw apiError(400, 'INVALID_WORKSPACE_DIRECTORY', '请明确指定已存在的绝对目录。');
  const cwd = directory;
  // 标签属于布局；只有调用方明确提供的目录才能用于启动终端。这里从不创建目录。
  let actual, base;
  try {
    actual = await fs.realpath(cwd);
    base = await fs.realpath(root);
  } catch {
    throw apiError(400, 'INVALID_WORKSPACE_DIRECTORY', '启动目录必须已经存在。');
  }
  const relative = path.relative(base, actual);
  if (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative) ||
    !(await fs.stat(cwd)).isDirectory()
  )
    throw apiError(400, 'INVALID_WORKSPACE_DIRECTORY', '工作区必须位于配置的根目录内。');
  return { cwd: actual, created: false };
}
module.exports = { prepareWorkspace };
