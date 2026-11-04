import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
for (const [name, global] of [
  ['provider-capabilities', 'StudioProviders'],
  ['session-sync', 'StudioSessionSync'],
]) {
  const source = fs.readFileSync(path.join(root, `shared/${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const output = `// Generated from shared/${name}.ts; do not edit.\n(function (root) {\n  const exports = {};\n${compiled}\n  if (typeof module === 'object' && module.exports) module.exports = exports;\n  else root.${global} = exports;\n})(typeof globalThis === 'undefined' ? this : globalThis);\n`;
  const file = path.join(root, `public/${name}.js`);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== output)
      throw new Error(`${name} is stale; run npm run generate:shared.`);
    console.log(`${name} is up to date`);
  } else fs.writeFileSync(file, output);
}
