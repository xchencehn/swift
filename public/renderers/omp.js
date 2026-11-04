(function (root) {
  'use strict';
  root.StudioRenderers.register({
    harnessId: 'omp',
    label: 'Oh My Pi',
    schemaVersion: 1,
    renderMessage(message, bubble, host) {
      bubble.append(...root.StudioRendererCommon.renderBlocks(message, host));
    },
  });
})(globalThis);
