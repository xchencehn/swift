'use strict';
const os = require('node:os');
function serverInfo({ port, host, basePath, token, rootDirectory }) {
  const address = (value) =>
    `http://${value.includes(':') ? '[' + value + ']' : value}:${port}${basePath}/`;
  const local = address('127.0.0.1');
  const exposed = ['0.0.0.0', '::'].includes(host);
  const addresses = [
    ...new Set(
      Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => n && !n.internal && (exposed || n.address === host))
        .map((n) => address(n.address)),
    ),
  ];
  const configured = process.env.SWIFT_PUBLIC_URL;
  if (configured) {
    const u = new URL(configured);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      throw Error('Invalid SWIFT_PUBLIC_URL');
    addresses.unshift(u.href.replace(/\/?$/, '/'));
  }
  const links = [...new Set(addresses)].map((base) => {
    const url = new URL(base);
    url.searchParams.set('token', token);
    return url.href;
  });
  return {
    ok: true,
    edition: 'open-source',
    version: require('../package.json').version,
    name: os.hostname(),
    host,
    port,
    rootDirectory,
    localUrl: local,
    localTrusted: process.env.SWIFT_DIRECT_AUTH !== 'token',
    connections: links,
  };
}
function formatSummary(info) {
  return [
    `Swift ${info.version} · 开源直连版`,
    `服务器：${info.name}`,
    `项目目录：${info.rootDirectory}`,
    `监听：${info.host}:${info.port}`,
    `本机 / Windows ↔ WSL：${info.localUrl}${info.localTrusted ? '（无需认证）' : '（此服务要求 token）'}`,
    ...info.connections.map((url) => `局域网连接：${url}`),
    '在客户端粘贴完整连接链接即可。',
  ].join('\n');
}
module.exports = { serverInfo, formatSummary };
