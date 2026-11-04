(function (root) {
  'use strict';
  root.StudioRenderers.register({
    harnessId: 'opencode',
    label: 'OpenCode',
    schemaVersion: 1,
    renderMessage(message, bubble, host) {
      bubble.append(...root.StudioRendererCommon.renderBlocks(message, host));
    },
  });
})(globalThis);
