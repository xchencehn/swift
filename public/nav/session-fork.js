(function (root) {
  'use strict';
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function run({ request, target, timeoutMs = 90000, stepMs = 250 }) {
    const requestId =
      root.crypto?.randomUUID?.() || `fork-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const now = () => root.performance?.now?.() ?? Date.now();
    const deadline = now() + timeoutMs;
    const expired = new Error('Fork 结果尚未确认，请查看 Tab 列表；Swift 不会自动重复创建。');
    const boundedRequest = async (body) => {
      const remaining = deadline - now();
      if (remaining <= 0) throw expired;
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => request(body)),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(expired), remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    let view;
    // Start exactly once. A lost HTTP reply is recovered with this request ID,
    // never by entering another command in the original conversation.
    try {
      view = await boundedRequest({ ...target, action: 'start', requestId });
    } catch (error) {
      if (
        error === expired ||
        error?.code === 'UNAUTHORIZED' ||
        (error?.status && error.status < 500)
      )
        throw error;
    }
    for (;;) {
      const job = view?.job;
      if (job?.status === 'succeeded') return job;
      if (job && ['failed', 'uncertain'].includes(job.status))
        throw new Error(job.message || 'Fork 尚未完成，请查看新 Tab。');
      const remaining = deadline - now();
      if (remaining <= 0) throw expired;
      await pause(Math.min(stepMs, remaining));
      try {
        view = await boundedRequest({ action: 'read', requestId });
      } catch (error) {
        if (
          error === expired ||
          error?.code === 'UNAUTHORIZED' ||
          error?.status === 401 ||
          error?.status === 403
        )
          throw error;
        // Keep querying the same receipt after a network interruption.
      }
    }
  }
  const api = { run };
  root.StudioSessionFork = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
