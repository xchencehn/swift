'use strict';
/**
 * Codex 的 Skill 列表，直接读文件。
 *
 * 原来经 app-server 的 `skills/list` 拿；改走 PTY 之后没有那条通道了，而 Skill 本来就是
 * 磁盘上的目录：`$CODEX_HOME/skills/<名字>/SKILL.md`（含 `.system` 下的系统 Skill），以及
 * 会话目录往上各级的 `.codex/skills`。`SKILL.md` 开头是 YAML frontmatter，只取
 * `name` 与 `description` 两个键。
 *
 * 形状与原接口一致：`{ skills: [{ name, description, path, scope, enabled }], errors }`。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** frontmatter 里的一个键。值可以带引号；多行写法只取第一行，够显示用。 */
function frontmatter(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!pair) continue;
    out[pair[1]] = pair[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function readRoot(root, scope, skills, errors, seen) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    if (entry.name === '.system') {
      readRoot(dir, 'system', skills, errors, seen);
      continue;
    }
    if (entry.name.startsWith('.')) continue;
    const file = path.join(dir, 'SKILL.md');
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const meta = frontmatter(text);
    const name = meta.name || entry.name;
    // 同名的以离会话更近的为准：项目里的 Skill 覆盖全局的同名 Skill。
    if (seen.has(name)) continue;
    if (!meta.description) errors.push({ path: file, message: 'SKILL.md 缺少 description' });
    seen.add(name);
    skills.push({ name, description: meta.description || '', path: file, scope, enabled: true });
  }
}

function listCodexSkills(
  cwd,
  { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {},
) {
  const skills = [],
    errors = [],
    seen = new Set();
  // 从会话目录往上找项目级 Skill，离得近的先登记，同名时它赢。
  for (let dir = path.resolve(cwd || '/'); ; dir = path.dirname(dir)) {
    readRoot(path.join(dir, '.codex', 'skills'), 'repo', skills, errors, seen);
    if (dir === path.dirname(dir)) break;
  }
  readRoot(path.join(codexHome, 'skills'), 'user', skills, errors, seen);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, errors };
}

module.exports = { listCodexSkills, frontmatter };
