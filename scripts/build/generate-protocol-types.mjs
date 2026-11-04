// Adapted from devswha/herdr-web-ui at 685293e0a7b912f28b3e19af7e07ae335cfb45e0.
// Copyright (c) 2026 devswha. MIT; see public/vendor/herdr-web-ui/LICENSE.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const ROOT = join(import.meta.dirname, '../..');
const SCHEMA_PATH = join(ROOT, 'shared', 'herdr-schema.json');
const OUTPUT_PATH = join(ROOT, 'shared', 'herdr-api.generated.ts');
const ROOTS = {
  success_response: ['SessionSnapshot', 'PaneReadResult', 'AgentManifestInfo'],
  request: [
    'AgentStartParams',
    'PaneReadParams',
    'PaneSendTextParams',
    'PaneSendKeysParams',
    'EventsSubscribeParams',
    'Subscription',
  ],
};
const SECTION_PREFIX = {
  request: 'Request',
  success_response: 'Response',
  event: 'Event',
  subscription_event: 'SubscriptionEvent',
  error_response: 'Error',
};
function parseRef(ref) {
  const parts = ref.split('/');
  const section = parts[2];
  const name = parts[4];
  if (!section || !name) throw new Error(`unsupported $ref: ${ref}`);
  return {
    section,
    name,
  };
}
function collect(schema) {
  const found = new Map();
  const visit = (section, name) => {
    const key = `${section}/${name}`;
    if (found.has(key)) return;
    const def = schema.schemas?.[section]?.$defs?.[name];
    if (!def) throw new Error(`missing definition ${key}`);
    found.set(key, {
      section,
      name,
      def,
    });
    walkRefs(def, (ref) => {
      const target = parseRef(ref);
      visit(target.section, target.name);
    });
  };
  for (const [section, names] of Object.entries(ROOTS)) {
    for (const name of names) visit(section, name);
  }
  return found;
}
function walkRefs(node, onRef) {
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, onRef);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') onRef(value);
    else walkRefs(value, onRef);
  }
}
function resolveNames(found) {
  const byName = new Map();
  for (const entry of found.values()) {
    const list = byName.get(entry.name) ?? [];
    list.push(entry);
    byName.set(entry.name, list);
  }
  const names = new Map();
  for (const [name, entries] of byName) {
    const shapes = new Set(entries.map((e) => JSON.stringify(e.def)));
    const ambiguous = entries.length > 1 && shapes.size > 1;
    for (const entry of entries) {
      const prefix = ambiguous ? (SECTION_PREFIX[entry.section] ?? entry.section) : '';
      names.set(`${entry.section}/${entry.name}`, `${prefix}${entry.name}`);
    }
  }
  return names;
}
function tsTypeOf(def, section, names, indent) {
  if (def.$ref) {
    const target = parseRef(def.$ref);
    const resolved = names.get(`${target.section}/${target.name}`);
    if (!resolved) throw new Error(`unresolved ref ${def.$ref}`);
    return resolved;
  }
  if (def.enum) {
    const literals = [...def.enum].sort().map((value) => JSON.stringify(value));
    return `${literals.join(' | ')} | (string & {})`;
  }
  if (def.oneOf || def.anyOf) {
    const variants = def.oneOf ?? def.anyOf;
    const rendered = [
      ...new Set(variants.map((variant) => tsTypeOf(variant, section, names, indent))),
    ];
    const meaningful = rendered.filter((type) => type !== 'unknown');
    return (meaningful.length > 0 ? meaningful : rendered).join(' | ');
  }
  const rawType = def.type;
  const types = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
  const nullable = types.includes('null');
  const primary = types.filter((t) => t !== 'null');
  const render = (kind) => {
    switch (kind) {
      case 'string':
        return 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        return `${tsTypeOf(def.items ?? {}, section, names, indent)}[]`;
      case 'object':
        return def.properties
          ? renderObject(def, section, names, indent)
          : 'Record<string, unknown>';
      default:
        return 'unknown';
    }
  };
  if (primary.length === 0) return nullable ? 'null' : 'unknown';
  const body = primary.map(render).join(' | ');
  return nullable ? `${body} | null` : body;
}
function renderObject(def, section, names, indent) {
  const properties = def.properties ?? {};
  const required = def.required ?? [];
  const inner = `${indent}  `;
  const lines = Object.keys(properties)
    .sort()
    .map((key) => {
      const optional = required.includes(key) ? '' : '?';
      const rendered = tsTypeOf(properties[key], section, names, inner);
      const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
      return `${inner}${safeKey}${optional}: ${rendered};`;
    });
  if (lines.length === 0) return 'Record<string, unknown>';
  return `{\n${lines.join('\n')}\n${indent}}`;
}
function generate(schema) {
  const found = collect(schema);
  const names = resolveNames(found);
  const emitted = new Map();
  for (const entry of found.values()) {
    const tsName = names.get(`${entry.section}/${entry.name}`);
    if (emitted.has(tsName)) continue;
    const isInterface = entry.def.type === 'object' && entry.def.properties && !entry.def.enum;
    emitted.set(
      tsName,
      isInterface
        ? `export interface ${tsName} ${renderObject(entry.def, entry.section, names, '')}`
        : `export type ${tsName} = ${tsTypeOf(entry.def, entry.section, names, '')};`,
    );
  }
  const declarations = [...emitted.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, declaration]) => declaration);
  const header = [
    '/**',
    ' * GENERATED FILE - DO NOT EDIT.',
    ' *',
    ` * Source: herdr API schema, protocol ${schema.protocol}, schema_version ${schema.schema_version}.`,
    ' * Regenerate with: npm run generate:types',
    ' * Verify freshness with: npm run generate:types -- --check',
    ' */',
    '',
  ].join('\n');
  return `${header}\n${declarations.join('\n\n')}\n`;
}
async function loadSchema(refresh) {
  if (refresh) {
    const herdr = process.env['SWIFT_HERDR_BIN'] || 'herdr';
    const text = execFileSync(herdr, ['api', 'schema', '--json'], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 16 * 1024 * 1024,
    });
    writeFileSync(SCHEMA_PATH, text);
    return JSON.parse(text);
  }
  if (!existsSync(SCHEMA_PATH)) throw new Error(`schema snapshot missing: ${SCHEMA_PATH}`);
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}
const args = process.argv.slice(2);
const check = args.includes('--check');
const schema = await loadSchema(args.includes('--refresh'));
const output = generate(schema);
if (check) {
  const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : '';
  if (current !== output) {
    console.error(
      `${OUTPUT_PATH} is STALE relative to ${SCHEMA_PATH}.\nRun: npm run generate:types`,
    );
    process.exit(1);
  }
  console.log('generated types are up to date');
} else {
  writeFileSync(OUTPUT_PATH, output);
  console.log(`wrote ${OUTPUT_PATH}`);
}
