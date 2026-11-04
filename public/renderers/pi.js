(function (root) {
  'use strict';
  root.StudioRenderers.register({
    harnessId: 'pi',
    label: 'Pi',
    schemaVersion: 1,
    renderMessage(message, bubble, host) {
      bubble.append(...root.StudioRendererCommon.renderBlocks(message, host));
    },
  });
})(globalThis);
