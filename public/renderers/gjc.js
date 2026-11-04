(function (root) {
  'use strict';
  root.StudioRenderers.register({
    harnessId: 'gjc',
    label: 'GJC',
    schemaVersion: 1,
    renderMessage(message, bubble, host) {
      bubble.append(...root.StudioRendererCommon.renderBlocks(message, host));
    },
  });
})(globalThis);
