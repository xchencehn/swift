'use strict';
window.StudioDesktopConnections.buildUpdates = (body) => {
  const section = document.createElement('section');
  section.className = 'device-settings-section desktop-connection-content';
  section.innerHTML =
    '<h2 class="settings-section-title">客户端更新</h2><p>更新此设备上的 Swift 客户端。</p><p class="client-update-version"></p><button type="button" class="check-client-update">检查更新</button> <button type="button" class="install-client-update" hidden>下载并安装</button><p role="status" aria-live="polite" class="hint"></p>';
  body.append(section);
  const check = section.querySelector('.check-client-update'),
    install = section.querySelector('.install-client-update');
  const status = section.querySelector('[role=status]'),
    version = section.querySelector('.client-update-version');
  let disposed = false,
    busy = false;
  const api = window.StudioDesktopConnections.api;
  void api('profiles')
    .then((value) => {
      if (!disposed) version.textContent = `当前客户端版本：${value.version}`;
    })
    .catch(() => {
      if (!disposed) version.textContent = '暂时无法读取客户端版本。';
    });
  async function run(action) {
    if (busy || disposed) return;
    busy = true;
    check.disabled = true;
    install.disabled = true;
    try {
      await action();
    } catch (error) {
      if (!disposed) status.textContent = error.message;
    } finally {
      busy = false;
      if (!disposed) {
        check.disabled = false;
        install.disabled = false;
      }
    }
  }
  check.addEventListener(
    'click',
    () =>
      void run(async () => {
        install.hidden = true;
        status.textContent = '正在检查客户端更新…';
        const update = await api('update/check', {});
        if (disposed) return;
        install.hidden = !update.available;
        status.textContent = update.available
          ? `发现客户端新版本 ${update.version}。安装后会重新打开软件，连接和草稿继续保留。`
          : '当前客户端已是最新版本。';
      }),
  );
  install.addEventListener('click', () => {
    if (!busy && confirm('下载并安装客户端新版本？软件会重新启动。'))
      void run(async () => {
        status.textContent = '正在下载并验证客户端更新，请稍候…';
        await api('update/install', {});
      });
  });
  return () => {
    disposed = true;
    section.remove();
  };
};
