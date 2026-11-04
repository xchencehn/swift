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
      const $ = (id) => root.querySelector('#' + id),
        manager = root.querySelector('.server-manager'),
        form = $('connectionForm'),
        dialog = $('addServerDialog'),
        menu = $('serverActions'),
        removeDialog = $('removeServerDialog'),
        isStart = root.id === 'connectionSetup',
        events = new AbortController();
      let disposed = false,
        busy = false,
        profiles = [],
        activeId,
        continuing,
        editing = null,
        repairing = false,
        rootValue = null,
        pendingPath = null,
        editSequence = 0,
        authenticationShown = false,
        menuProfile = null,
        menuTrigger = null,
        removal = null,
        failureProfile = null,
        cleanupServerUpdates = null;
      const svg = (paths) => {
        const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        node.setAttribute('viewBox', '0 0 24 24');
        node.setAttribute('aria-hidden', 'true');
        for (const d of paths) {
          const path = document.createElementNS(node.namespaceURI, 'path');
          path.setAttribute('d', d);
          node.append(path);
        }
        return node;
      };
      const machineIcon = () =>
        svg([
          'M5 3h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
          'M5 14h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z',
          'M7 6.5h.01M7 17.5h.01',
        ]);
      function setStatus(target, text) {
        target.textContent = text;
        if (target === $('serverListStatus')) {
          $('serverFeedback').hidden = !text;
          $('repairServer').hidden = !failureProfile;
        }
      }
      function closeMenu() {
        menuTrigger?.setAttribute('aria-expanded', 'false');
        if (menu.matches(':popover-open')) menu.hidePopover();
      }
      function showMenu(profile, trigger) {
        if (busy) return;
        if (
          menu.matches(':popover-open') &&
          menuProfile?.id === profile.id &&
          menuTrigger === trigger
        ) {
          closeMenu();
          return;
        }
        closeMenu();
        menuProfile = profile;
        menuTrigger = trigger;
        trigger.setAttribute('aria-expanded', 'true');
        menu.showPopover();
        const rect = trigger.getBoundingClientRect(),
          bounds = menu.getBoundingClientRect();
        menu.style.left =
          Math.max(8, Math.min(innerWidth - bounds.width - 8, rect.right - bounds.width)) + 'px';
        menu.style.top =
          (rect.bottom + bounds.height + 8 < innerHeight
            ? rect.bottom + 5
            : Math.max(8, rect.top - bounds.height - 5)) + 'px';
        menu.querySelector('button').focus();
      }
      menu.addEventListener('toggle', (event) => {
        if (event.newState === 'closed' && !menu.matches(':popover-open'))
          menuTrigger?.setAttribute('aria-expanded', 'false');
      });
      menu.addEventListener('keydown', (event) => {
        const buttons = [...menu.querySelectorAll('button')],
          index = buttons.indexOf(document.activeElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          menuTrigger?.focus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          buttons[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          ].focus();
        }
      });
      window.addEventListener('resize', closeMenu, { signal: events.signal });
      function focusProfile(id) {
        const target =
          continuing?.id === id && !$('continueSection').hidden
            ? $('continueMore')
            : root.querySelector(`[data-profile="${id}"] .server-row-menu`);
        (target || $('addServer')).focus({ preventScroll: true });
      }
      function openAddServer() {
        if (busy || disposed) return;
        closeMenu();
        cleanupServerUpdates?.();
        cleanupServerUpdates = null;
        $('editServerUpdates').hidden = true;
        editing = null;
        repairing = false;
        rootValue = null;
        pendingPath = null;
        editSequence++;
        form.reset();

        setStatus($('status'), '');
        $('addServerTitle').textContent = '添加服务器';
        $('connectButton').textContent = '添加并连接';
        $('closeAddServer').setAttribute('aria-label', '关闭添加服务器');
        $('editServerRootFields').hidden = true;
        dialog.showModal();
        $('address').focus();
        $('address').select();
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
      function openEditServer(profile, repair = false) {
        if (busy || !profile) return;
        openAddServer();
        editing = profile;
        repairing = repair;
        $('addServerTitle').textContent = repair ? '更新连接链接' : '编辑服务器';
        $('connectButton').textContent = repair ? '保存并重试' : '保存';
        $('closeAddServer').setAttribute('aria-label', '关闭编辑服务器');
        $('name').value = profile.name;
        $('address').value = profile.address;

        $('editServerRootFields').hidden = repair;
        if (repair) {
          setStatus($('status'), '连接凭据不正确或已失效。请粘贴服务器显示的最新完整链接。');
          $('address').focus();
          $('address').select();
          return;
        }
        $('editServerRootBrowse').hidden = !window.StudioDesktopConnections.chooseDirectory;
        void readRoot();
        $('editServerUpdates').hidden = false;
        cleanupServerUpdates = window.StudioServerUpdates?.mount($('editServerUpdates'), {
          request,
          path: (suffix) => `/e/${profile.id}${suffix}`,
        });
      }
      function closeAddServer() {
        if (removeDialog.open) {
          if (!busy) removeDialog.close();
          return true;
        }
        if (menu.matches(':popover-open')) {
          closeMenu();
          menuTrigger?.focus();
          return true;
        }
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
        // A pasted link may contain a credential; do not keep it in a closed form.
        $('address').value = '';
        setStatus($('status'), '');
        if (pendingPath && !disposed) location.assign(pendingPath);
        else if (!disposed) {
          if (editing) focusProfile(editing.id);
          else $('addServer').focus();
        }
      });
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
      async function run(
        action,
        status = $('serverListStatus'),
        button = null,
        pendingText = '正在连接…',
      ) {
        if (busy || disposed) return;
        busy = true;
        closeMenu();
        setStatus(status, '');
        const controls = [...root.querySelectorAll('button,input')].map((node) => [
          node,
          node.disabled,
        ]);
        const labelNode = button?.querySelector('[data-button-label],strong') || button,
          label = labelNode?.textContent;
        for (const [node] of controls) node.disabled = true;
        if (button) {
          labelNode.textContent = pendingText;
          button.setAttribute('aria-busy', 'true');
        }
        try {
          await action();
        } catch (error) {
          if (!disposed) setStatus(status, error.message || '操作未完成，请重试。');
        } finally {
          busy = false;
          for (const [node, disabled] of controls) node.disabled = disabled;
          if (button) {
            labelNode.textContent = label;
            button.removeAttribute('aria-busy');
          }
        }
      }
      function activate(profile, button) {
        if (!profile || busy) return;
        closeMenu();
        failureProfile = profile;
        // Returning to this window's already selected server keeps cached startup local.
        if (profile.id === activeId && !new URLSearchParams(location.search).has('failed')) {
          location.assign(`/e/${profile.id}/`);
          return;
        }
        void run(
          async () => {
            const result = await api('activate', { id: profile.id });
            if (!disposed) location.assign(result.path);
          },
          $('serverListStatus'),
          button,
        );
      }
      $('connectionBack').addEventListener('click', () =>
        activate(continuing, $('connectionBack')),
      );
      $('continueNewWindow').addEventListener('click', () => {
        if (!busy && continuing) openWindow(continuing.id);
      });
      $('continueMore').addEventListener('click', () => showMenu(continuing, $('continueMore')));
      $('openServerWindow').addEventListener('click', () => {
        const profile = menuProfile;
        closeMenu();
        if (!busy && profile) openWindow(profile.id);
      });
      $('editServer').addEventListener('click', () => openEditServer(menuProfile));
      $('removeServer').addEventListener('click', () => {
        if (busy) return;
        removal = menuProfile;
        closeMenu();
        $('removeServerName').textContent = removal.name;
        $('removeServerStatus').textContent = '';
        removeDialog.showModal();
        $('cancelRemoveServer').focus();
      });
      $('cancelRemoveServer').addEventListener('click', () => {
        if (!busy) removeDialog.close();
      });
      removeDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        if (!busy) removeDialog.close();
      });
      removeDialog.addEventListener('close', () => {
        if (!disposed && removal) focusProfile(removal.id);
      });
      $('confirmRemoveServer').addEventListener(
        'click',
        () =>
          void run(
            async () => {
              const profile = removal;
              await api('remove', { id: profile.id });
              if (disposed) return;
              if (failureProfile?.id === profile.id) {
                failureProfile = null;
                setStatus($('serverListStatus'), '');
              }
              if (sessionStorage.getItem('swiftDesktopConnection') === profile.id)
                sessionStorage.removeItem('swiftDesktopConnection');
              removeDialog.close();
              if (profile.id === currentId) location.assign('/connect');
              else await load();
            },
            $('removeServerStatus'),
            $('confirmRemoveServer'),
            '正在移除…',
          ),
      );
      $('repairServer').addEventListener('click', () => openEditServer(failureProfile));
      $('retryServerList').addEventListener('click', () => {
        if (failureProfile) activate(failureProfile, $('retryServerList'));
        else void run(load);
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const profile = editing,
          input = {
            mode: 'direct',
            address: $('address').value.trim(),
            token: '',
            name: $('name').value.trim(),
          };
        const changedRoot =
          profile && rootValue !== null && $('editServerRoot').value.trim() !== rootValue
            ? $('editServerRoot').value.trim()
            : null;
        if (changedRoot === '') {
          setStatus($('status'), '请输入根目录的绝对路径。');
          return;
        }
        void run(
          async () => {
            const result = await api(
              profile ? 'update' : 'connect',
              profile ? { id: profile.id, ...input } : input,
            );
            if (disposed) return;
            if (!profile) {
              $('address').value = '';
              location.assign(result.path);
              return;
            }
            const changed =
              profile &&
              (profile.address !== result.profile.address || input.address.includes('token='));
            $('address').value = result.profile.address;
            editing = result.profile;
            if (repairing || (profile.id === currentId && changed)) pendingPath = result.path;
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
          },
          $('status'),
          $('connectButton'),
          profile && !repairing ? '正在保存…' : '正在连接…',
        );
      });
      function render() {
        const query = $('serverSearch').value.trim().toLocaleLowerCase();
        continuing = isStart && !query ? profiles.find((profile) => profile.id === activeId) : null;
        const visible = profiles.filter(
          (profile) =>
            profile !== continuing &&
            (!query || `${profile.name} ${profile.address}`.toLocaleLowerCase().includes(query)),
        );
        $('serverLoading').hidden = true;
        $('serverEmpty').hidden = profiles.length > 0;
        $('serverSearchField').hidden = profiles.length < 4 && !query;
        $('continueSection').hidden = !continuing;
        manager.classList.toggle('has-continue', Boolean(continuing && visible.length));
        if (continuing) {
          $('continueName').textContent = continuing.name;
          $('continueAddress').textContent = continuing.address;
          $('continueContext').textContent =
            sessionStorage.getItem('swiftDesktopConnection') === continuing.id
              ? '当前窗口'
              : '上次连接';
          $('continueMore').setAttribute('aria-label', '管理服务器：' + continuing.name);
          $('connectionBack').querySelector('[data-button-label]').textContent =
            new URLSearchParams(location.search).has('failed') ? '重试连接' : '继续会话';
        }
        $('savedSection').hidden = !visible.length && !query;
        $('savedHeading').textContent = continuing ? '其他服务器' : '已保存的服务器';
        $('serverCount').textContent = String(visible.length);
        $('serverNoResults').hidden = Boolean(visible.length);
        $('profiles').replaceChildren();
        for (const profile of visible) {
          const row = document.createElement('div'),
            open = document.createElement('button'),
            info = document.createElement('span'),
            name = document.createElement('strong'),
            detail = document.createElement('small'),
            more = document.createElement('button');
          row.className = 'server-row';
          row.dataset.profile = profile.id;
          open.className = 'server-row-open';
          open.type = 'button';
          open.setAttribute('aria-label', '连接到 ' + profile.name);
          info.className = 'server-row-info';
          name.textContent = profile.name;
          detail.textContent =
            (!isStart && profile.id === activeId ? '当前服务器 · ' : '') + profile.address;
          open.title = `${profile.name}\n${profile.address}`;
          info.append(name, detail);
          open.append(machineIcon(), info, svg(['M5 12h14m-6-6 6 6-6 6']));
          open.addEventListener('click', () => activate(profile, open));
          more.className = 'server-icon-button server-row-menu';
          more.type = 'button';
          more.setAttribute('aria-label', '管理服务器：' + profile.name);
          more.setAttribute('aria-haspopup', 'menu');
          more.setAttribute('aria-expanded', 'false');
          more.append(svg(['M5 12h.01M12 12h.01M19 12h.01']));
          more.addEventListener('click', () => showMenu(profile, more));
          row.append(open, more);
          $('profiles').append(row);
        }
      }
      $('serverSearch').addEventListener('input', render);
      $('clearServerSearch').addEventListener('click', () => {
        $('serverSearch').value = '';
        render();
        $('serverSearch').focus();
      });
      async function load() {
        const state = await api('profiles');
        if (disposed) return;
        activeId = state.active;
        profiles = state.profiles;
        render();
        const params = new URLSearchParams(location.search),
          failedId = params.get('failed');
        if (failedId && !authenticationShown) {
          failureProfile = profiles.find((profile) => profile.id === failedId) || null;
          setStatus(
            $('serverListStatus'),
            failureProfile
              ? `无法连接 ${failureProfile.name}。请确认服务器已启动，或编辑连接链接后重试。`
              : '无法连接上次的服务器。请选择其他服务器或添加连接。',
          );
        }
        if (!authenticationShown && params.has('auth')) {
          authenticationShown = true;
          const profile = profiles.find((item) => item.id === activeId);
          if (profile) openEditServer(profile, true);
          else {
            openAddServer();

            setStatus($('status'), '连接凭据不正确或已失效。请重新粘贴服务器打印的连接链接。');
          }
          $('address').focus();
          $('address').select();
        }
      }
      void load().catch((error) => {
        if (!disposed) {
          $('serverLoading').hidden = true;
          setStatus($('serverListStatus'), error.message);
        }
      });
      return () => {
        disposed = true;
        events.abort();
        closeMenu();
        cleanupServerUpdates?.();
        dialog.close();
        removeDialog.close();
        $('address').value = '';
        if (window.StudioDesktopConnections.closeAddServer === closeAddServer)
          delete window.StudioDesktopConnections.closeAddServer;
      };
    },
  };
  document.getElementById('newWindow')?.addEventListener('click', () => openWindow());
  const connectionSetup = document.getElementById('connectionSetup');
  if (connectionSetup) window.StudioDesktopConnections.mount(connectionSetup);
})();
