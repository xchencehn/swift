'use strict';

/**
 * A routing table for the API surface, replacing a linear chain of method and
 * path comparisons. Handlers stay small because the router owns three things
 * that were repeated in every branch: dispatch, error responses, and the
 * distinction between an unknown path and an unsupported method on a known one.
 *
 * Paths are matched exactly. There are no parameters or prefixes: every route
 * in this product addresses a fixed endpoint and carries its target in the
 * query string or body, which keeps target resolution an explicit step rather
 * than something the router guesses.
 */
class Router {
  constructor({ json, sendError }) {
    this.json = json;
    this.sendError = sendError;
    this.routes = new Map();
  }

  /** Register `handler` for one or more methods on one or more paths. */
  add(methods, paths, handler) {
    for (const path of [].concat(paths)) {
      const byMethod = this.routes.get(path) || new Map();
      for (const method of [].concat(methods)) {
        if (byMethod.has(method)) throw new Error(`重复注册路由：${method} ${path}`);
        byMethod.set(method, handler);
      }
      this.routes.set(path, byMethod);
    }
  }

  get(paths, handler) {
    this.add('GET', paths, handler);
  }
  post(paths, handler) {
    this.add('POST', paths, handler);
  }

  /** Every registered path, for tests and for startup checks. */
  paths() {
    return [...this.routes.keys()].sort();
  }

  /**
   * Run the handler for this request. Returns false when the path is unknown,
   * so the caller decides what an unrouted request means.
   */
  async dispatch(req, res, url) {
    const byMethod = this.routes.get(url.pathname);
    if (!byMethod) return false;
    const handler = byMethod.get(req.method);
    if (!handler) {
      this.json(res, 405, {
        ok: false,
        code: 'METHOD_NOT_ALLOWED',
        message: '不支持这个请求方法。',
      });
      return true;
    }
    try {
      await handler(req, res, url);
    } catch (error) {
      // Handlers that need a different error shape catch it themselves; this
      // is the shared path that every branch used to repeat.
      this.sendError(res, error);
    }
    return true;
  }
}

module.exports = { Router };
