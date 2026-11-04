'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { authorizeDirect } = require('../lib/http/direct-auth');
test('trusted direct connections reject browser cross-origin requests and DNS rebinding', () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: '127.0.0.1' } });
  assert(authorizeDirect(req({ host: 'localhost:8792', origin: 'http://localhost:8792' })));
  assert(
    !authorizeDirect(
      req({ host: 'attacker.invalid:8792', origin: 'http://attacker.invalid:8792' }),
    ),
  );
  assert(!authorizeDirect(req({ host: '127.0.0.1:8792', origin: 'https://attacker.invalid' })));
  assert(!authorizeDirect(req({ host: '127.0.0.1:8792', origin: 'null' })));
  assert(!authorizeDirect(req({ host: '127.0.0.1:8792', 'sec-fetch-site': 'cross-site' })));
  assert(!authorizeDirect(req({ host: '127.0.0.1:8792', 'x-forwarded-for': '127.0.0.1' })));
  assert(
    !authorizeDirect({
      headers: { host: '192.168.1.2:8792' },
      socket: { remoteAddress: '192.168.1.3' },
    }),
  );
});
