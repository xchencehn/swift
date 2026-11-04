'use strict';
const net = require('node:net');
const os = require('node:os');
function trustedAddress(address) {
  const ip = String(address || '')
    .toLowerCase()
    .replace(/^::ffff:/, '');
  return net.isIP(ip) === 4 ? ip.startsWith('127.') : ip === '::1';
}
function localAddresses() {
  return new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter(Boolean)
      .map((n) => n.address),
  );
}
function authorizeDirect(req) {
  if (
    req.headers.forwarded ||
    req.headers['x-forwarded-for'] ||
    req.headers['x-forwarded-host'] ||
    req.headers['sec-fetch-site'] === 'cross-site'
  )
    return false;
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  // Windows host addresses are explicitly detected/configured by the WSL installer.
  const wslPeers =
    process.platform === 'linux' && /microsoft/i.test(os.release())
      ? String(process.env.SWIFT_WSL_HOST || '')
          .split(',')
          .filter(Boolean)
      : [];
  if (!trustedAddress(peer) && !wslPeers.includes(peer)) return false;
  if (!req.headers.host) return !req.headers.origin;
  try {
    const target = new URL('http://' + req.headers.host);
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (!['localhost', ...localAddresses(), ...wslPeers].includes(host) && !trustedAddress(host))
      return false;
    if (req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== target.host)
        return false;
    }
  } catch {
    return false;
  }
  return true;
}
module.exports = { trustedAddress, authorizeDirect };
