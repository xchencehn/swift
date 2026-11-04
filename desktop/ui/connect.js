'use strict';
(() => {
  const currentId = location.pathname.match(/^\/e\/([a-f0-9]{64})(?:\/|$)/)?.[1];
  if (currentId) sessionStorage.setItem('swiftDesktopConnection', currentId);
  function openWindow(id) {
    window.open(id ? `/e/${id}/` : '/connect', '_blank', 'noopener');
  }
  window.addEventListener(
    'keydown',
    (event) => {
      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.code === 'KeyN' &&
        !event.repeat
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        openWindow();
      }
    },
    true,
  );
  async function api(path, body) {
    const response = await fetch('/desktop/' + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(result.message || '连接失败。'), {
        code: result.code,
        status: response.status,
      });
    if (path === 'profiles') {
      const localId = currentId || sessionStorage.getItem('swiftDesktopConnection');
      if (currentId || result.profiles.some((profile) => profile.id === localId))
        result.active = localId;
      const current = result.profiles.find((profile) => profile.id === currentId);
      if (current) document.title = `Swift — ${current.name}`;
      window.StudioServerSwitcher?.updateIdentity?.(result);
    }
    return result;
  }
  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      handleAuthError: true,
      credentials: 'same-origin',
    });
    const body = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(body.message || '无法读取服务器设置。'), {
        status: response.status,
      });
    return body;
  }
  window.StudioDesktopConnections = {
    api,
    request,
    openWindow,
    allowDirect: true,
    mount(root) {
      let disposed = false,
        busy = false,
        activeId,
        returnId,
        editing = null,
        rootValue = null,
        pendingPath = null,
        editSequence = 0,
        authenticationShown = false;
      let cleanupServerUpdates = null;
      const $ = (id) => root.querySelector('#' + id),
        form = $('connectionForm');
      const dialog = $('addServerDialog');
      function openAddServer() {
        cleanupServerUpdates?.();
        cleanupServerUpdates = null;
        $('editServerUpdates').hidden = true;
        editing = null;
        rootValue = null;
        pendingPath = null;
        editSequence++;
        form.reset();
        modeChanged();
        $('status').textContent = '';
        $('addServerTitle').textContent = '添加服务器';
        $('connectButton').textContent = '添加并连接';
        $('closeAddServer').setAttribute('aria-label', '关闭添加服务器');
        $('editServerRootFields').hidden = true;
        dialog.showModal();
        $('name').focus();
      }
      async function readRoot() {
        const profile = editing,
          sequence = ++editSequence;
        rootValue = null;
        $('editServerRoot').disabled = true;
        $('editServerRootBrowse').disabled = true;
        $('editServerRoot').value = '';
        $('editServerRootStatus').textContent = '正在读取根目录…';
        $('retryServerRoot').hidden = true;
        try {
          const config = await request(`/e/${profile.id}/api/config`);
          if (disposed || !dialog.open || sequence !== editSequence) return;
          rootValue = config.rootDirectory;
          $('editServerRoot').value = rootValue;
          $('editServerRoot').disabled = busy;
          $('editServerRootBrowse').disabled = busy;
          $('editServerRootStatus').textContent = '';
        } catch (error) {
          if (disposed || !dialog.open || sequence !== editSequence) return;
          $('editServerRootStatus').textContent = error.message;
          $('retryServerRoot').hidden = false;
        }
      }
      function openEditServer(profile) {
        openAddServer();
        editing = profile;
        $('addServerTitle').textContent = '编辑服务器';
        $('connectButton').textContent = '保存';
        $('closeAddServer').setAttribute('aria-label', '关闭编辑服务器');
        $('name').value = profile.name;
        form.elements.mode.value = profile.address.includes('127.0.0.1:8792') ? 'local' : 'lan';
        $('address').value = profile.address;
        $('token').placeholder = '留空保留已保存的 Token';
        modeChanged();
        $('editServerRootFields').hidden = false;
        $('editServerRootBrowse').hidden = !window.StudioDesktopConnections.chooseDirectory;
        void readRoot();
        $('editServerUpdates').hidden = false;
        cleanupServerUpdates = window.StudioServerUpdates?.mount($('editServerUpdates'), {
          request,
          path: (suffix) => `/e/${profile.id}${suffix}`,
        });
      }
      $('retryServerRoot').addEventListener('click', () => void readRoot());
      $('editServerRootBrowse').addEventListener('click', async () => {
        const profile = editing,
          sequence = editSequence;
        const selected = await window.StudioDesktopConnections.chooseDirectory(
          profile,
          $('editServerRoot').value.trim(),
        );
        if (!disposed && dialog.open && sequence === editSequence && selected)
          $('editServerRoot').value = selected;
      });
      function closeAddServer() {
        if (!dialog.open) return false;
        if (!busy) dialog.close();
        return true;
      }
      window.StudioDesktopConnections.closeAddServer = closeAddServer;
      $('addServer').addEventListener('click', openAddServer);
      for (const id of ['closeAddServer', 'cancelAddServer'])
        $(id).addEventListener('click', closeAddServer);
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeAddServer();
      });
      dialog.addEventListener('close', () => {
        cleanupServerUpdates?.();
        cleanupServerUpdates = null;
        editSequence++;
        $('token').value = '';
        $('status').textContent = '';
        if (pendingPath && !disposed) location.assign(pendingPath);
        else if (editing && !disposed)
          root.querySelector(`[data-profile="${editing.id}"] .profileInfo`)?.focus();
      });
      async function run(action, status = $('serverListStatus')) {
        if (busy) return;
        busy = true;
        status.textContent = '';
        const buttons = [...root.querySelectorAll('button,input')].map((button) => [
          button,
          button.disabled,
        ]);
        for (const [button] of buttons) button.disabled = true;
        try {
          await action();
        } catch (error) {
          if (!disposed) status.textContent = error.message;
        } finally {
          busy = false;
          for (const [button, disabled] of buttons) button.disabled = disabled;
        }
      }
      function modeChanged() {
        const mode = form.elements.mode.value;
        $('address').required = true;
        $('address').disabled = false;
        $('connectionHint').textContent =
          mode === 'lan'
            ? '在服务器执行 swift，将摘要中带 token 的完整链接粘贴到这里。'
            : mode === 'wsl'
              ? '本机 Windows 与 WSL 直接连接，无需认证。'
              : '同一系统内直接连接，无需认证。';
      }
      form.addEventListener('change', modeChanged);
      modeChanged();
      $('connectionBack').addEventListener(
        'click',
        () =>
          void run(async () => {
            if (activeId) location.assign(`/e/${activeId}/`);
            else if (returnId) location.assign((await api('activate', { id: returnId })).path);
          }),
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const mode = form.elements.mode.value,
          profile = editing;
        const input = {
          mode,
          address: $('address').value.trim(),
          token: '',
          name: $('name').value.trim(),
        };
        const changedRoot =
          profile && rootValue !== null && $('editServerRoot').value.trim() !== rootValue
            ? $('editServerRoot').value.trim()
            : null;
        if (changedRoot === '') {
          $('status').textContent = '请输入根目录的绝对路径。';
          return;
        }
        void run(async () => {
          const result = await api(
            profile ? 'update' : 'connect',
            profile ? { id: profile.id, ...input } : input,
          );
          $('token').value = '';
          if (disposed) return;
          if (!profile) {
            location.assign(result.path);
            return;
          }
          const connectionChanged =
            profile.address !== result.profile.address || $('address').value.includes('token=');
          editing = result.profile;
          $('token').required = false;
          if (profile.id === currentId && connectionChanged) pendingPath = result.path;
          await load();
          if (changedRoot !== null) {
            try {
              const config = window.StudioDesktopConnections.saveRoot
                ? await window.StudioDesktopConnections.saveRoot(editing, changedRoot)
                : await request(`/e/${editing.id}/api/config`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ rootDirectory: changedRoot }),
                  });
              rootValue = config.rootDirectory;
            } catch (error) {
              throw new Error('服务器信息已保存；根目录未保存：' + error.message);
            }
          }
          dialog.close();
        }, $('status'));
      });
      async function load() {
        const state = await api('profiles');
        if (disposed) return;
        activeId = state.active;
        $('profiles').replaceChildren();
        $('savedSection').hidden = !state.profiles.length;
        returnId =
          activeId ||
          state.profiles.find((profile) => profile.mode === 'direct')?.id ||
          state.profiles[0]?.id;
        $('connectionBack').hidden = root.id !== 'connectionSetup' || !returnId;
        for (const profile of state.profiles) {
          const row = document.createElement('div'),
            info = document.createElement('button'),
            name = document.createElement('strong'),
            detail = document.createElement('small'),
            actions = document.createElement('div');
          row.className = 'profile';
          row.dataset.profile = profile.id;
          info.className = 'profileInfo';
          info.type = 'button';
          info.setAttribute('aria-haspopup', 'dialog');
          info.setAttribute('aria-label', '编辑服务器：' + profile.name);
          info.addEventListener('click', () => openEditServer(profile));
          name.textContent = profile.name;
          detail.textContent = (profile.id === activeId ? '当前服务器 · ' : '') + profile.address;
          info.append(name, detail);
          const open = document.createElement('button');
          open.type = 'button';
          open.textContent = '连接';
          open.addEventListener(
            'click',
            () =>
              void run(async () => {
                const result = await api('activate', { id: profile.id });
                location.assign(result.path);
              }),
          );
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'remove';
          remove.textContent = '移除';
          remove.addEventListener('click', () => {
            if (confirm('移除这个服务器和已保存的凭据？'))
              void run(async () => {
                await api('remove', { id: profile.id });
                if (profile.id === activeId) location.assign('/connect');
                else await load();
              });
          });
          const separate = document.createElement('button');
          separate.type = 'button';
          separate.textContent = '在新窗口打开';
          separate.addEventListener('click', () => openWindow(profile.id));
          actions.append(open, separate, remove);
          row.append(info, actions);
          $('profiles').append(row);
        }
        if (!authenticationShown && new URLSearchParams(location.search).has('auth')) {
          authenticationShown = true;
          openAddServer();
          form.elements.mode.value = 'lan';
          modeChanged();
          $('status').textContent = '连接凭据不正确或已失效。请重新粘贴服务器打印的连接链接。';
          $('address').focus();
        }
      }
      void load().catch((error) => {
        if (!disposed) $('serverListStatus').textContent = error.message;
      });
      return () => {
        disposed = true;
        cleanupServerUpdates?.();
        dialog.close();
        $('token').value = '';
        if (window.StudioDesktopConnections.closeAddServer === closeAddServer)
          delete window.StudioDesktopConnections.closeAddServer;
      };
    },
  };
  const connectionSetup = document.getElementById('connectionSetup');
  if (connectionSetup) window.StudioDesktopConnections.mount(connectionSetup);
})();
