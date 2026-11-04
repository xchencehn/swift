'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createFrontendAssets } = require('../lib/frontend-assets');

test('HTML report host has an opaque script sandbox without weakening the app CSP', async () => {
  const handler = require('../lib/http/static').createStaticHandler({
    directory: path.join(__dirname, '../public'),
    basePath: '',
    token: 'fixture',
    getSettings: () => ({}),
  });
  const read = (pathname) =>
    new Promise((resolve) => {
      let status, headers;
      handler(
        { headers: {}, method: 'GET' },
        {
          writeHead: (s, h) => {
            status = s;
            headers = h;
          },
          end: (body) => resolve({ status, headers, body }),
        },
        new URL('http://fixture' + pathname),
      );
    });
  const app = await read('/'),
    report = await read('/files/html-preview.html');
  assert.equal(report.status, 200);
  assert.match(app.headers['content-security-policy'], /script-src 'self';/);
  const policy = report.headers['content-security-policy'];
  assert.match(policy, /sandbox allow-scripts;/);
  assert(!policy.includes('allow-same-origin'));
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ])
    assert(policy.includes(directive));
  assert.equal(report.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(report.headers['cache-control'], 'no-store');
});

test('startup bundle preserves script order, parses and invalidates when source changes', () => {
  const vm = require('node:vm');
  const actual = createFrontendAssets(path.join(__dirname, '../public'));
  const bundle = actual.startup();
  new vm.Script(bundle.data.toString());
  assert(bundle.files.length > 30);
  assert.equal(bundle.files.at(-1), 'app.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bundle-'));
  try {
    const html =
      '<!-- APP_SCRIPTS_START --><script src="a.js?v=__ASSET_VERSION__"></script><script src="b.js?v=__ASSET_VERSION__"></script><!-- APP_SCRIPTS_END -->';
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'a.js'), 'globalThis.order = [1]');
    fs.writeFileSync(path.join(dir, 'b.js'), 'globalThis.order.push(2)');
    const assets = createFrontendAssets(dir),
      first = assets.startup(),
      context = {};
    vm.runInNewContext(first.data.toString(), context);
    assert.equal(context.order.join(','), '1,2');
    assert.equal(assets.startup(), first);
    fs.writeFileSync(path.join(dir, 'b.js'), 'globalThis.order.push(3)');
    const modified = new Date(Date.now() + 1000);
    fs.utimesSync(path.join(dir, 'b.js'), modified, modified);
    const next = assets.startup();
    assert.notEqual(next.version, first.version);
    assert(assets.bundleHtml(html).includes(`assets/startup.js?v=${next.version}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTML template unchanged: gzip must follow the rendered asset version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-assets-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<script src="app.js?v=VERSION"></script>');
    fs.writeFileSync(path.join(dir, 'app.js'), 'old');
    const assets = createFrontendAssets(dir),
      template = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    const render = () => Buffer.from(template.replace('VERSION', assets.version()));
    const before = render();
    assert.deepEqual(zlib.gunzipSync(assets.gzip('index.html', before)), before);
    fs.writeFileSync(path.join(dir, 'app.js'), 'updated');
    const after = render();
    assert.notDeepEqual(after, before);
    assert.deepEqual(zlib.gunzipSync(assets.gzip('index.html', after)), after);
    assert.equal(assets.gzip('index.html', after), assets.gzip('index.html', after));
    const initialVersion = assets.version();
    fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg/>');
    assert.notEqual(assets.version(), initialVersion);
    const withIcon = assets.version();
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images', 'welcome.svg'), 'new');
    assert.notEqual(assets.version(), withIcon);
    const withNested = assets.version();
    fs.unlinkSync(path.join(dir, 'icon.svg'));
    assert.notEqual(assets.version(), withNested);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('单个文件的版本只随它自己变', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-assets-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'a');
    fs.writeFileSync(path.join(dir, 'b.js'), 'b');
    const assets = createFrontendAssets(dir);
    const a = assets.fileVersion('a.js'),
      b = assets.fileVersion('b.js');
    fs.writeFileSync(path.join(dir, 'b.js'), 'b changed');
    assert.equal(assets.fileVersion('a.js'), a);
    assert.notEqual(assets.fileVersion('b.js'), b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gzip cache bounds retained bytes, evicts least recently used responses and invalidates content', () => {
  const assets = createFrontendAssets('.');
  const body = Buffer.alloc(6 * 1024 * 1024, 'a');
  const a = assets.gzip('a', body),
    b = assets.gzip('b', body);
  assert.equal(assets.gzip('a', body), a);
  assets.gzip('c', body);
  assert.equal(assets.gzip('a', body), a);
  assert.notEqual(assets.gzip('b', body), b);
  const updated = Buffer.from('updated response');
  const response = assets.gzip('a', updated);
  assert.deepEqual(zlib.gunzipSync(response), updated);
  assert.equal(assets.gzip('a', updated), response);
  const oversized = Buffer.alloc(16 * 1024 * 1024, 'b');
  assert.notEqual(assets.gzip('large', oversized), assets.gzip('large', oversized));
});

test('gzip cache also bounds the number of tiny entries', () => {
  const assets = createFrontendAssets('.'),
    body = Buffer.from('small'),
    oldest = assets.gzip('0', body);
  let newest;
  for (let n = 1; n < 129; n++) newest = assets.gzip(String(n), body);
  assert.equal(assets.gzip('128', body), newest);
  assert.notEqual(assets.gzip('0', body), oldest);
});
