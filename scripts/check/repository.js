'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const names = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'utf8' },
).split('\0');
const files = [...new Set(names)].filter((name) => name && fs.existsSync(path.join(root, name)));
const failures = [];
const owned = (name) =>
  !name.startsWith('public/vendor/') &&
  !name.startsWith('third_party/') &&
  !name.startsWith('test/fixtures/');
for (const name of files) {
  const file = path.join(root, name),
    stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    const target = fs.realpathSync(file);
    if (path.relative(root, target).split(path.sep).includes('..'))
      failures.push(`${name}: link points outside this repository`);
    continue;
  }
  if (
    /(?:^|\/)(?:auth\.json|\.env(?:\..*)?|id_(?:rsa|ed25519)|signing\.properties|local\.properties)$/.test(
      name,
    ) &&
    !name.endsWith('.example')
  )
    failures.push(`${name}: local configuration must remain outside Git`);
  if (!owned(name)) continue;
  if (/\.(?:js|cjs|mjs)$/.test(name)) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const resolve = createRequire(file).resolve;
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'require' &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text.startsWith('.')
      ) {
        try {
          resolve(node.arguments[0].text);
        } catch {
          failures.push(`${name}: unresolved module ${node.arguments[0].text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (name.endsWith('.md')) {
    const text = fs.readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
      if (!fs.existsSync(path.resolve(path.dirname(file), decodeURIComponent(target))))
        failures.push(`${name}: missing document target ${target}`);
    }
  }
}
const commands = require('../../package.json').scripts;
for (const [name, command] of Object.entries(commands)) {
  for (const match of command.matchAll(/\bnode\s+(scripts\/[^\s]+\.m?js)\b/g))
    if (!fs.existsSync(path.join(root, match[1])))
      failures.push(`package.json ${name}: missing script ${match[1]}`);
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Repository links, local imports and package commands checked (${files.length} files).`,
  );
