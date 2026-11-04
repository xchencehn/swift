(function () {
  'use strict';
  function mount(host, { request, path, version }) {
    const section = document.createElement('section');
    section.className = 'device-settings-section server-update-settings';
    section.innerHTML =
      '<h3>服务器更新</h3><p class="server-update-version"></p><button type="button" class="chat-btn">检查更新</button><p role="status" aria-live="polite"></p><a target="_blank" rel="noopener" hidden>下载服务器安装包</a><p class="server-update-instructions" hidden>将安装包传到这台服务器，按包内说明完成安装，再重新连接。</p>';
    const label = section.querySelector('.server-update-version'),
      button = section.querySelector('button');
    const status = section.querySelector('[role=status]'),
      download = section.querySelector('a');
    const instructions = section.querySelector('.server-update-instructions');
    label.textContent = version ? `当前服务器版本：${version}` : '正在读取服务器版本…';
    host.append(section);
    const controller = new AbortController();
    let disposed = false,
      busy = false;
    if (!version)
      void request(path('/api/config'), { signal: controller.signal })
        .then((config) => {
          if (!disposed)
            label.textContent = config.version
              ? `当前服务器版本：${config.version}`
              : '此服务器版本暂不提供版本信息。';
        })
        .catch(() => {
          if (!disposed) label.textContent = '无法读取服务器版本，可重新检查更新。';
        });
    button.addEventListener('click', async () => {
      if (busy || disposed) return;
      busy = true;
      button.disabled = true;
      download.hidden = true;
      instructions.hidden = true;
      status.textContent = '正在检查服务器更新…';
      try {
        const update = await request(path('/api/server-update'), { signal: controller.signal });
        if (disposed) return;
        label.textContent = `当前服务器版本：${update.currentVersion}`;
        status.textContent = update.available
          ? `发现服务器新版本 ${update.version}。`
          : '当前服务器已是最新版本。';
        if (update.available) {
          download.href = update.downloadUrl;
          download.hidden = false;
          instructions.hidden = false;
        }
      } catch (error) {
        if (!disposed)
          status.textContent =
            error.status === 404
              ? '此服务器暂不支持检查更新，请在服务器上更新 Swift。'
              : '无法检查服务器更新，请重试。';
      } finally {
        busy = false;
        if (!disposed) button.disabled = false;
      }
    });
    return () => {
      disposed = true;
      controller.abort();
      section.remove();
    };
  }
  window.StudioServerUpdates = { mount };
})();
