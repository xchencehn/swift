'use strict';
const http = require('node:http'),
  net = require('node:net');
const { once } = require('node:events');
const { createFixture } = require('../chat-harness');
const { createHttp, json, securityHeaders } = require('../../../lib/http');
async function createTokenFixture(options) {
  const fixture = await createFixture(options),
    target = new URL(fixture.url);
  const state = { token: 'fixture-direct-token', documentQueries: [], denied: 0, authenticated: 0 };
  const auth = createHttp({ tokens: [state.token], maxBodyBytes: 1024 * 1024 });
  let filesRouter = null;
  if (options?.workspaceDirectory) {
    fixture.state.rootDirectory = options.workspaceDirectory;
    for (const workspace of fixture.state.workspaces) workspace.cwd = options.workspaceDirectory;
    for (const session of Object.values(fixture.state.sessions))
      session.pane.cwd = options.workspaceDirectory;
    filesRouter = new (require('../../../lib/http/router').Router)({
      json,
      sendError: auth.sendError,
    });
    require('../../../lib/http/routes/workspace-files').register(filesRouter, {
      currentRoot: () => ({ data: { directory: options.workspaceDirectory } }),
      json,
      readJson: auth.readJson,
      apiError: require('../../../lib/message-queue').apiError,
      securityHeaders,
    });
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') state.documentQueries.push(url.search);
    if (url.pathname.startsWith('/api/') || url.pathname === '/fixture/echo') {
      if (state.token !== 'fixture-direct-token' || !auth.requireAuth(req, res, url)) {
        if (state.token !== 'fixture-direct-token') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ code: 'UNAUTHORIZED' }));
        }
        state.denied++;
        return;
      }
      state.authenticated++;
    }
    if (url.pathname === '/fixture/echo') {
      req.pipe(res);
      return;
    }
    if (filesRouter && url.pathname.startsWith('/api/workspace-files/')) {
      if (!(await filesRouter.dispatch(req, res, url))) json(res, 404, { ok: false });
      return;
    }
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (
      state.token !== 'fixture-direct-token' ||
      !auth.isAuthorized(req, new URL(req.url, 'http://localhost'))
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n')}\r\n\r\n`,
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    fixture,
    state,
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fixture.close();
    },
  };
}
module.exports = { createTokenFixture };
