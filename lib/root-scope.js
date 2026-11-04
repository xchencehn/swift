'use strict';
const fs = require('node:fs');
const path = require('node:path');

function withinRoot(root, directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) return false;
  const canonical = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const relative = path.relative(canonical(root), canonical(directory));
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
function scopeDashboard(dashboard, rootDirectory) {
  // 根目录隔离 Swift 历史、缓存和草稿，不改变 Herdr 的运行布局。
  // foreground cwd 会随 cd 改变，不能用它决定一个终端是否存在。
  return {
    ...dashboard,
    rootDirectory,
    panes: dashboard.panes || [],
    workspaces: dashboard.workspaces || [],
  };
}
module.exports = { withinRoot, scopeDashboard };
