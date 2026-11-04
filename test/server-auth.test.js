'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-auth-root-'));
process.env.SWIFT_TOKEN_FILE = path.join(root, 'direct-token.json');
process.env.CODEX_SIDE_SOCKET = path.join(root, 'no-side.sock');
process.env.AGENT_STUDIO_ROOT_DIR = root;
process.env.AGENT_STUDIO_SETTINGS_FILE = path.join(root, 'bootstrap.json');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

process.env.SWIFT_DIRECT_AUTH = 'token';
process.env.AGENT_STUDIO_TOKEN = 'known-test-token';
process.env.AGENT_STUDIO_ANDROID_TOKEN = 'dedicated-android-token';
process.env.AGENT_STUDIO_HIDE_STARTUP_URLS = '1';
const { isAuthorized, normalizeBasePath } = require('../server');

function request(headers = {}) {
  return { headers, socket: { remoteAddress: '127.0.0.1' } };
}

test('auth accepts header token', () => {
  const url = new URL('http://localhost/api/health');
  assert.equal(isAuthorized(request({ 'x-agent-studio-token': 'known-test-token' }), url), true);
});

test('non-ASCII token of equal character length is rejected without throwing', () => {
  assert.equal(
    isAuthorized(
      request({ 'x-agent-studio-token': 'é'.repeat('known-test-token'.length) }),
      new URL('http://localhost/api/health'),
    ),
    false,
  );
});

test('auth accepts the independently revocable Android token', () => {
  const url = new URL('http://localhost/api/health');
  assert.equal(
    isAuthorized(request({ 'x-agent-studio-token': 'dedicated-android-token' }), url),
    true,
  );
});

test('auth accepts query or cookie token and rejects mismatches', () => {
  assert.equal(isAuthorized(request(), new URL('http://localhost/?token=known-test-token')), true);
  assert.equal(
    isAuthorized(
      request({ cookie: 'agentStudioToken=known-test-token' }),
      new URL('http://localhost/'),
    ),
    true,
  );
  assert.equal(
    isAuthorized(request({ 'x-agent-studio-token': 'wrong' }), new URL('http://localhost/')),
    false,
  );
});

test('base path normalization is stable for direct and proxied deployments', () => {
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath('swift/'), '/swift');
  assert.equal(normalizeBasePath('//swift//'), '/swift');
});

test('removed authentication names are not accepted by swift', () => {
  const url = new URL('http://localhost/api/config');
  assert.equal(isAuthorized(request({ 'x-mobile-typer-token': 'known-test-token' }), url), false);
  assert.equal(isAuthorized(request({ cookie: 'herdrMiniToken=known-test-token' }), url), false);
});

test('execution defaults to trusted direct access without a token', () => {
  delete process.env.SWIFT_DIRECT_AUTH;
  try {
    assert.equal(isAuthorized(request(), new URL('http://localhost/api/config')), true);
    assert.equal(
      isAuthorized(
        { headers: {}, socket: { remoteAddress: '8.8.8.8' } },
        new URL('http://localhost/api/config'),
      ),
      false,
    );
  } finally {
    process.env.SWIFT_DIRECT_AUTH = 'token';
  }
});
