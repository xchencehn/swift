'use strict';

window.StudioServerSwitcher = {
  mount(connections) {
    const settings = document.getElementById('chatDeviceSettings');
    if (
      !settings ||
      document.getElementById('serverSwitch') ||
      new URLSearchParams(location.search).get('surface') === 'pane'
    )
      return;
    const footer = document.createElement('div');
    footer.className = 'server-sidebar-actions';
    settings.before(footer);
    footer.append(settings);

    const trigger = document.createElement('button');
    trigger.id = 'serverSwitch';
    trigger.className = 'server-trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', 'serverPopover');
    trigger.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01" stroke-linecap="round"/></svg><span>服务器</span><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>';
    const popup = document.createElement('div');
    popup.id = 'serverPopover';
    popup.className = 'server-popover';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-label', '切换服务器');
    popup.hidden = true;
    const heading = document.createElement('div');
    heading.className = 'server-heading';
    heading.textContent = '服务器';
    const list = document.createElement('div');
    list.className = 'server-list';
    const status = document.createElement('p');
    status.id = 'serverStatus';
    status.className = 'server-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    const manage = document.createElement('button');
    manage.className = 'server-manage';
    manage.type = 'button';
    manage.textContent = '管理服务器';
    popup.append(heading, list, status);
    if (connections.openWindow) {
      const newWindow = document.createElement('button');
      newWindow.id = 'serverNewWindow';
      newWindow.className = 'server-manage';
      newWindow.type = 'button';
      newWindow.textContent = '新建窗口';
      newWindow.title = '新建窗口 (Ctrl+Shift+N)';
      newWindow.addEventListener('click', () => {
        connections.openWindow();
        close();
      });
      popup.append(newWindow);
    }
    popup.append(manage);
    footer.append(trigger, popup);
    let activeId = '',
      loading = false,
      switching = false,
      generation = 0;

    const identityGeneration = generation;
    Promise.resolve()
      .then(() => connections.api('profiles'))
      .then((saved) => {
        if (generation === identityGeneration && !saved.error) {
          activeId = saved.active;
          paintIdentity(saved.profiles, activeId);
        }
      })
      .catch(() => {
        trigger.title = '无法读取当前服务器，请打开查看';
      });

    function say(text, error = false) {
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle('error', error);
    }
    function close(restoreFocus = false) {
      popup.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      generation += 1;
      if (restoreFocus) trigger.focus({ preventScroll: true });
    }
    window.StudioServerSwitcher.closeOpen = () => {
      if (popup.hidden) return false;
      close(true);
      return true;
    };
    function buttons() {
      return [...popup.querySelectorAll('button:not(:disabled)')];
    }
    function paintIdentity(profiles, currentId) {
      const current = profiles.find((profile) => profile.id === currentId);
      trigger.querySelector('span').textContent = current?.name || '服务器';
      trigger.title = current ? `当前服务器：${current.name}` : '选择服务器';
      trigger.setAttribute('aria-label', `${trigger.title}，切换服务器`);
    }
    window.StudioServerSwitcher.updateIdentity = (saved) =>
      paintIdentity(saved.profiles, saved.active);
    function render(profiles) {
      paintIdentity(profiles, activeId);
      list.replaceChildren();
      for (const profile of profiles) {
        const button = document.createElement('button');
        button.className = 'server-option';
        button.type = 'button';
        button.dataset.serverId = profile.id;
        const current = profile.id === activeId;
        if (current) button.setAttribute('aria-current', 'true');
        const info = document.createElement('span');
        info.className = 'server-info';
        const name = document.createElement('span');
        name.className = 'server-name';
        name.textContent = profile.name;
        const address = document.createElement('small');
        address.textContent = profile.address;
        info.append(name, address);
        button.title = `${profile.name}\n${address.textContent}`;
        button.append(info);
        if (current) {
          const mark = document.createElement('span');
          mark.className = 'server-current';
          mark.textContent = '当前';
          button.append(mark);
          trigger.title = `当前服务器：${profile.name}`;
        }
        button.addEventListener('click', () => void activate(profile));
        if (connections.openWindow) {
          const row = document.createElement('div');
          row.className = 'server-window-row';
          const separate = document.createElement('button');
          separate.type = 'button';
          separate.className = 'server-open-window';
          separate.title = `在新窗口打开 ${profile.name}`;
          separate.setAttribute('aria-label', separate.title);
          separate.innerHTML =
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/></svg>';
          separate.addEventListener('click', () => {
            connections.openWindow(profile.id);
            close();
          });
          row.append(button, separate);
          list.append(row);
        } else list.append(button);
      }
    }
    async function open(focusLast = false) {
      if (switching) return;
      popup.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      loading = true;
      popup.setAttribute('aria-busy', 'true');
      list.replaceChildren();
      say('正在读取已保存的服务器…');
      const mine = ++generation;
      try {
        const saved = await connections.api('profiles');
        if (mine !== generation || popup.hidden) return;
        if (saved.error) throw new Error(saved.error);
        activeId = saved.active;
        render(saved.profiles);
        say(saved.profiles.length ? '' : '还没有保存服务器，请在管理服务器中添加。');
      } catch (error) {
        if (mine !== generation || popup.hidden) return;
        say(error.message || '无法读取服务器，请关闭后重试。', true);
      } finally {
        if (mine === generation && !popup.hidden) {
          loading = false;
          popup.removeAttribute('aria-busy');
          if (document.activeElement === trigger) {
            const available = buttons();
            (focusLast ? available.at(-1) : available[0])?.focus({ preventScroll: true });
          }
        }
      }
    }
    async function activate(profile) {
      if (loading || switching) return;
      if (profile.id === activeId) {
        close(true);
        return;
      }
      if (profile.mode !== 'direct') {
        say('请使用服务器显示的直连链接重新添加连接。', true);
        return;
      }
      switching = true;
      popup.setAttribute('aria-busy', 'true');
      trigger.setAttribute('aria-busy', 'true');
      for (const button of popup.querySelectorAll('button')) button.disabled = true;
      say(`正在连接 ${profile.name}…`);
      try {
        const result = await connections.api('activate', { id: profile.id });
        if (result?.path) location.assign(result.path);
      } catch (error) {
        say(error.message || '切换失败，请重试。', true);
        switching = false;
        trigger.removeAttribute('aria-busy');
        popup.removeAttribute('aria-busy');
        for (const button of [trigger, ...popup.querySelectorAll('button')])
          button.disabled = false;
        if (!popup.hidden)
          list
            .querySelector(`[data-server-id="${CSS.escape(profile.id)}"]`)
            ?.focus({ preventScroll: true });
      }
    }
    trigger.addEventListener('click', () => (popup.hidden ? void open() : close()));
    trigger.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      void open(event.key === 'ArrowUp');
    });
    manage.addEventListener('click', () => {
      close();
      if (connections.manage) connections.manage();
      else {
        settings.click();
        document.getElementById('settingsConnectionTab')?.click();
        document.getElementById('settingsConnectionTab')?.focus({ preventScroll: true });
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!popup.hidden && !popup.contains(event.target) && !trigger.contains(event.target))
        close();
    });
    window.addEventListener(
      'keydown',
      (event) => {
        if (popup.hidden) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          close(true);
          return;
        }
        if (
          !popup.contains(event.target) ||
          !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const available = buttons(),
          index = available.indexOf(document.activeElement);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? available.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) %
                available.length;
        available[next]?.focus({ preventScroll: true });
      },
      true,
    );
    document.addEventListener('focusin', (event) => {
      if (!popup.hidden && !popup.contains(event.target) && event.target !== trigger) close();
    });
  },
};

if (window.StudioApp?.savedConnections && window.StudioApp?.switchConnection) {
  const pending = new Map();
  window.addEventListener('swift:connection-result', (event) => {
    const result = event.detail,
      operation = pending.get(result?.requestId);
    if (!operation) return;
    pending.delete(result.requestId);
    if (result.ok) operation.resolve(result);
    else operation.reject(new Error(result.message || '切换失败，请重试。'));
  });
  window.StudioServerSwitcher.mount({
    api(path, body) {
      if (path === 'profiles')
        return Promise.resolve(JSON.parse(window.StudioApp.savedConnections()));
      if (path !== 'activate') return Promise.reject(new Error('不支持的连接操作。'));
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        try {
          window.StudioApp.switchConnection(body.id, requestId);
        } catch {
          pending.delete(requestId);
          reject(new Error('无法切换服务器，请重试。'));
        }
      });
    },
    manage() {
      window.StudioApp.connectionSettings();
    },
  });
}
