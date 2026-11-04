'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { trustedAddress, authorizeDirect } = require('../lib/http/direct-auth');
const { createHttp } = require('../lib/http');
const { serverInfo, formatSummary } = require('../lib/server-info');
test('only actual loopback peers inherit local trust; LAN and forwarded peers require credentials', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert(trustedAddress(ip));
  for (const ip of ['10.0.0.1', '192.168.1.1', '172.28.0.3', '169.254.1.1', 'fc00::1', '8.8.8.8'])
    assert(!trustedAddress(ip));
  const req = { headers: { host: '127.0.0.1:8792' }, socket: { remoteAddress: '127.0.0.1' } };
  assert(authorizeDirect(req));
  for (const header of [
    { 'x-forwarded-for': '127.0.0.1' },
    { origin: 'https://other.invalid' },
    { host: 'rebound.invalid' },
    { 'sec-fetch-site': 'cross-site' },
  ])
    assert(!authorizeDirect({ ...req, headers: { ...req.headers, ...header } }));
  const auth = createHttp({ tokens: ['lan-fixture-secret'], maxBodyBytes: 1024, authorizeDirect });
  const lan = { headers: { host: '192.168.1.2:8792' }, socket: { remoteAddress: '192.168.1.3' } };
  assert(!auth.isAuthorized(lan, new URL('http://192.168.1.2/')));
  assert(auth.isAuthorized(lan, new URL('http://192.168.1.2/?token=lan-fixture-secret')));
});
test('server summary provides a pasteable token link and preserves the local entry', () => {
  const authBefore = process.env.SWIFT_DIRECT_AUTH;
  process.env.SWIFT_DIRECT_AUTH = 'local';
  const before = process.env.SWIFT_PUBLIC_URL;
  process.env.SWIFT_PUBLIC_URL = 'http://127.0.0.1:18792/swift/';
  try {
    const info = serverInfo({
      port: 8792,
      host: '127.0.0.1',
      basePath: '/swift',
      token: 'fixture-only',
      rootDirectory: '/fixture',
    });
    assert.equal(info.localUrl, 'http://127.0.0.1:8792/swift/');
    assert.equal(info.connections[0], 'http://127.0.0.1:18792/swift/?token=fixture-only');
    assert(formatSummary(info).includes('无需认证'));
  } finally {
    if (authBefore === undefined) delete process.env.SWIFT_DIRECT_AUTH;
    else process.env.SWIFT_DIRECT_AUTH = authBefore;
    if (before === undefined) delete process.env.SWIFT_PUBLIC_URL;
    else process.env.SWIFT_PUBLIC_URL = before;
  }
});
