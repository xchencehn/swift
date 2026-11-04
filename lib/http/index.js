'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');

function normalizeBasePath(value) {
  const clean = String(value || '').trim();
  if (!clean || clean === '/') return '';
  return `/${clean.replace(/^\/+|\/+$/g, '')}`;
}

function securityHeaders(extra = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy':
      "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; frame-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; manifest-src 'self'",
    ...extra,
  };
}

function json(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  const send = (bytes, compressed = false) => {
    if (res.destroyed) return;
    res.writeHead(
      status,
      securityHeaders({
        'content-type': 'application/json; charset=utf-8',
        'content-length': bytes.length,
        'cache-control': 'no-store',
        vary: 'Accept-Encoding',
        ...(compressed ? { 'content-encoding': 'gzip' } : {}),
        ...extraHeaders,
      }),
    );
    res.end(bytes);
  };
  if (body.length > 2048 && res.acceptsGzip)
    zlib.gzip(body, { level: 1 }, (error, compressed) => send(error ? body : compressed, !error));
  else send(body);
}

function createHttp({ tokens, maxBodyBytes, authorizeDirect = () => false }) {
  function parseCookies(header) {
    const cookies = {};
    for (const part of String(header || '').split(';')) {
      const index = part.indexOf('=');
      if (index < 0) continue;
      const key = part.slice(0, index).trim();
      if (!key) continue;
      try {
        cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        cookies[key] = part.slice(index + 1).trim();
      }
    }
    return cookies;
  }

  // Keep both token header and cookie names compatible with installed clients.
  function requestToken(req, url) {
    const cookies = parseCookies(req.headers.cookie);
    return String(
      req.headers['x-agent-studio-token'] ||
        req.headers['x-swift-token'] ||
        url.searchParams.get('token') ||
        cookies.agentStudioToken ||
        cookies.swiftAuth ||
        '',
    );
  }

  function isAuthorized(req, url) {
    if (authorizeDirect(req)) return true;
    const provided = requestToken(req, url);
    if (!provided) return false;
    return tokens.some(
      (expected) =>
        expected &&
        Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
        crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected)),
    );
  }

  function requireAuth(req, res, url) {
    if (isAuthorized(req, url)) return true;
    json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
    return false;
  }

  function readBody(req, limit = maxBodyBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          reject(
            Object.assign(new Error('请求内容过大。'), { status: 413, code: 'BODY_TOO_LARGE' }),
          );
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function readJson(req, { maxBytes = maxBodyBytes } = {}) {
    const raw = await readBody(req, maxBytes);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('请求 JSON 格式不正确。'), { status: 400, code: 'BAD_JSON' });
    }
  }

  function sendError(res, error) {
    const status =
      error.status ||
      (error.code === 'TARGET_NOT_FOUND' ? 404 : error.code === 'SERVER_NOT_RUNNING' ? 503 : 500);
    json(res, status, {
      ok: false,
      code: error.code || 'INTERNAL_ERROR',
      message: error.message || '服务处理失败。',
      ...(typeof error.diagnosticId === 'string' ? { diagnosticId: error.diagnosticId } : {}),
      ...(typeof error.deliveryUncertain === 'boolean'
        ? { deliveryUncertain: error.deliveryUncertain }
        : {}),
      ...(typeof error.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    });
  }

  return { isAuthorized, requireAuth, readJson, sendError };
}
module.exports = { normalizeBasePath, securityHeaders, json, createHttp };
