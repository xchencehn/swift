/* highlight.js runs off the UI thread and can be terminated on pathological input. */
importScripts('../vendor/highlight/highlight.min.js');
self.onmessage = (event) => {
  const { id, request } = event.data;
  let result = null;
  try {
    if (request.source.length <= 256 * 1024 && self.hljs.getLanguage(request.language))
      result = self.hljs.highlight(request.source, {
        language: request.language,
        ignoreIllegals: true,
      }).value;
  } catch {
    /* The original plain text remains readable. */
  }
  self.postMessage({ id, result });
};
self.postMessage({ ready: true });
