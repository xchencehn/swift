'use strict';

const { opendir, mkdir, stat } = require('node:fs/promises');
const { basename, dirname, join, resolve, isAbsolute } = require('node:path');
const os = require('node:os');

/**
 * 目录浏览:新建工作区时得先说清楚"建在哪个目录下"。
 *
 * 终端里这件事是隐式的 —— 人先 cd 过去再建,当前目录就是答案;聊天页里没有
 * "当前目录"这个概念,所以要把它显式地选出来。做法参照 DeepSeek Harness 的
 * directory-picker:**一次只列一层** + **从根到当前的面包屑**,而不是一次给整棵树。
 * 大目录下一次性回传几万个条目既慢又没人看得完。
 *
 * 隐藏目录照常返回,只做标记 —— `.config`、`.claude` 这些恰恰是常要进的地方,
 * 直接藏掉反而碍事,交给界面决定默认显不显示。
 */

/** 一层最多回传这么多个子目录。超大目录(node_modules 之类)不该把接口拖死。 */
const MAX_ENTRIES = 400;

/** 从文件系统根到 target 的祖先链,每一级都可以跳过去。 */
function crumbs(target) {
  const chain = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    chain.unshift({ name: parent === current ? current : basename(current), path: current });
    if (parent === current) return chain;
    current = parent;
  }
}

/**
 * 列出一层子目录。
 *
 * @param {string} [path] 要列的目录;不给就从 home 开始
 * @returns {Promise<{path: string, crumbs: Array, entries: Array, truncated: boolean, parent: string|null}>}
 */
async function listDirectory(path) {
  const home = os.homedir();
  const raw = typeof path === 'string' && path.trim() ? path.trim() : home;
  // 只接受绝对路径:相对路径会按服务进程的工作目录解析,那不是用户以为的位置。
  if (!isAbsolute(raw)) {
    const error = new Error('需要绝对路径。');
    error.code = 'BAD_PATH';
    throw error;
  }
  const target = resolve(raw);
  let info;
  try {
    info = await stat(target);
  } catch {
    const error = new Error('这个目录不存在或没有权限。');
    error.code = 'NOT_FOUND';
    throw error;
  }
  if (!info.isDirectory()) {
    const error = new Error('这不是一个目录。');
    error.code = 'NOT_DIRECTORY';
    throw error;
  }

  const entries = [];
  let truncated = false;
  let dir;
  try {
    dir = await opendir(target);
  } catch {
    const error = new Error('读不了这个目录。');
    error.code = 'UNREADABLE';
    throw error;
  }
  try {
    for await (const item of dir) {
      // 只要目录:这里选的是"工作区落在哪儿",文件不是候选项。
      // 符号链接跟随 —— 指向目录的链接照样是个能进去的位置。
      let isDir = item.isDirectory();
      if (!isDir && item.isSymbolicLink()) {
        try {
          isDir = (await stat(join(target, item.name))).isDirectory();
        } catch {
          isDir = false;
        }
      }
      if (!isDir) continue;
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      entries.push({
        name: item.name,
        path: join(target, item.name),
        hidden: item.name.startsWith('.'),
      });
    }
  } finally {
    try {
      await dir.close();
    } catch {
      /* 已经读完的目录关不上也无所谓 */
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    crumbs: crumbs(target),
    entries,
    truncated,
    home,
  };
}

/** 在某个目录下新建一级子目录,并返回它的完整路径。 */
async function createDirectory(parentPath, name) {
  const clean = String(name || '').trim();
  // 只允许建一级:带分隔符就可能是 ../.. 这类穿越,直接拒绝而不是替换。
  if (!clean || clean === '.' || clean === '..' || /[\\/]/.test(clean)) {
    const error = new Error('目录名不能为空,也不能包含路径分隔符。');
    error.code = 'BAD_NAME';
    throw error;
  }
  const base = await listDirectory(parentPath); // 顺带校验父目录存在且可读
  const target = join(base.path, clean);
  await mkdir(target);
  return target;
}

module.exports = { listDirectory, createDirectory, crumbs, MAX_ENTRIES };
