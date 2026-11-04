'use strict';

/**
 * The one place the page talks HTTP to its own service.
 *
 * It owns three things that were repeated at every call site: the device and
 * token headers, the base path prefix, and turning a failure response into an
 * Error carrying the service's own `code`. Callers get a parsed body or an
 * exception; they never inspect status codes themselves.
 */
window.StudioApi = {
  create({
    basePath = '',
    deviceId,
    getToken,
    timeoutMs = 20000,
    fetchImpl = globalThis.fetch.bind(globalThis),
  }) {
    const path = (pathname) => `${basePath}${pathname}`;

    function headers(extra = {}) {
      const token = getToken();
      return {
        ...extra,
        'x-agent-studio-device-id': deviceId,
        ...(token ? { 'x-agent-studio-token': token } : {}),
      };
    }

    // 调用方给的 signal（例如切走会话时作废）与超时同时生效，哪个先到都中止。
    function signalFor(signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      if (!signal) return timeout;
      return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
    }

    async function request(pathname, options = {}) {
      const signal = signalFor(options.signal);
      try {
        const response = await fetchImpl(pathname, {
          ...options,
          signal,
          credentials: 'same-origin',
          headers: headers(options.headers || {}),
        });
        let body;
        try {
          body = await response.json();
        } catch (error) {
          if (signal.aborted) throw error;
          if (response.ok)
            throw Object.assign(new Error('服务返回的数据不完整，请稍后重试。'), {
              code: 'INVALID_RESPONSE',
            });
          body = {};
        }
        if (response.status === 401) {
          const error = new Error('访问令牌不正确。');
          error.code = 'UNAUTHORIZED';
          throw error;
        }
        if (!response.ok || body.ok === false) {
          const error = new Error(body.message || body.error || `请求失败（${response.status}）`);
          error.code = body.code;
          error.status = response.status;
          if (typeof body.deliveryUncertain === 'boolean')
            error.deliveryUncertain = body.deliveryUncertain;
          if (typeof body.retryable === 'boolean') error.retryable = body.retryable;
          throw error;
        }
        return body;
      } catch (error) {
        if (signal.aborted && signal.reason?.name === 'TimeoutError')
          throw Object.assign(new Error('服务请求等待超时，请稍后重试。'), {
            code: 'REQUEST_TIMEOUT',
            cause: error,
          });
        throw error;
      }
    }

    /** Same as `request`, but takes an endpoint under the app's base path. */
    const call = (endpoint, options) => request(path(endpoint), options);

    return { request, call, headers, path };
  },
};
