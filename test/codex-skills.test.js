'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listCodexSkills, frontmatter } = require('../lib/codex-skills');

function skill(root, dir, head) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, dir, 'SKILL.md'), `---\n${head}\n---\n正文\n`);
}

test('读全局、系统与项目级 Skill，项目里的同名 Skill 覆盖全局的', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skills-'));
  const home = path.join(base, 'home'),
    repo = path.join(base, 'repo');
  skill(path.join(home, 'skills'), 'herdr', 'name: herdr\ndescription: "全局的 herdr"');
  skill(
    path.join(home, 'skills', '.system'),
    'imagegen',
    'name: imagegen\ndescription: 系统 Skill',
  );
  skill(path.join(repo, '.codex', 'skills'), 'herdr', 'name: herdr\ndescription: 项目里的 herdr');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  const { skills, errors } = listCodexSkills(path.join(repo, 'src', 'deep'), { codexHome: home });
  assert.deepEqual(
    skills.map((s) => [s.name, s.scope, s.description]),
    [
      ['herdr', 'repo', '项目里的 herdr'],
      ['imagegen', 'system', '系统 Skill'],
    ],
  );
  assert.deepEqual(errors, []);
  assert(skills.every((s) => s.enabled && s.path.endsWith('SKILL.md')));
});

test('缺 description 的照样列出，但记一条错误', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skills-'));
  skill(path.join(home, 'skills'), 'bare', 'name: bare');
  const { skills, errors } = listCodexSkills('/', { codexHome: home });
  assert.equal(skills[0].name, 'bare');
  assert.equal(errors.length, 1);
});

test('frontmatter 去掉引号，没有就返回空对象', () => {
  assert.deepEqual(frontmatter('---\nname: \'a\'\ndescription: "b c"\n---\n'), {
    name: 'a',
    description: 'b c',
  });
  assert.deepEqual(frontmatter('# 没有 frontmatter'), {});
});
