/* File tree adapted from DeepSeek Harness (MIT), see third_party/deepseek-harness. */
(function (root) {
  'use strict';
  const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const orderEntries = (entries) =>
    [...entries].sort(
      (a, b) =>
        Number(b.type === 'directory') - Number(a.type === 'directory') ||
        byName.compare(a.name, b.name),
    );
  const childPath = (parent, name) => `${parent.replace(/[/\\]+$/, '')}/${name}`;
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const button = (label, action, cls = '') => {
    const node = make('button', cls, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  function icon(directory, expanded = false) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(svg.namespaceURI, 'path');
    line.setAttribute(
      'd',
      directory
        ? expanded
          ? 'M3 8V5h6l3 3h8v3M3 11h19l-4 9H3Z'
          : 'M3 7V4h6l3 3h9v13H3Z'
        : 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6',
    );
    svg.append(line);
    return svg;
  }
  function delay(signal) {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, 2500);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  function create({
    state,
    request,
    fetchBlob,
    closeDrawer,
    beforeOpen,
    onClose,
    popovers,
    copyText,
    askConfirm,
    namespace = '',
  }) {
    const sidebar = document.querySelector('#workspaceFilesTree'),
      page = document.querySelector('#workspaceFilesPage');
    const treeBody = sidebar.querySelector('.workspace-tree-body'),
      treePath = sidebar.querySelector('.workspace-tree-path');
    const tablist = page.querySelector('.workspace-file-tabs'),
      views = page.querySelector('.workspace-file-views');
    const pathbar = page.querySelector('.workspace-file-path'),
      mode = page.querySelector('.workspace-file-source');
    const status = page.querySelector('.workspace-file-notice');
    const edit = page.querySelector('.workspace-file-edit'),
      commit = page.querySelector('.workspace-file-save'),
      cancel = page.querySelector('.workspace-file-cancel');
    const copy = page.querySelector('.workspace-file-copy'),
      outlineToggle = page.querySelector('.workspace-file-outline-toggle');
    const life = new AbortController();
    let rootPath = '',
      tree = null,
      levels = new Map(),
      expanded = new Set(),
      treeScroll = 0,
      shown = false;
    let tabs = [],
      active = null,
      restoreFocus = null,
      inert = [],
      epoch = 0,
      sidebarKey = '',
      pendingTreeScroll = null;
    let readingWidth = null;
    const normalized = (text) => text.replace(/\r\n?/g, '\n');
    const dirty = (tab) => Boolean(tab.editing && tab.editor?.isDirty());
    const storeKey = () => `swiftWorkspaceFiles:${namespace}:${rootPath}`;
    const urlFor = (action, path) =>
      '/api/workspace-files/' + action + '?' + new URLSearchParams({ root: rootPath, path });
    const visibleTree = () =>
      !sidebar.hidden &&
      !document.hidden &&
      sidebar.getClientRects().length > 0 &&
      getComputedStyle(sidebar).visibility !== 'hidden';
    function save() {
      if (!rootPath) return;
      try {
        localStorage.setItem(
          storeKey(),
          JSON.stringify({
            expanded: [...expanded].slice(0, 128),
            scrollTop: treeBody.scrollTop || treeScroll,
            paths: tabs.map((tab) => tab.path),
            active: active?.path,
            readingWidth,
          }),
        );
      } catch {
        /* The current view still works without storage. */
      }
    }
    function clear() {
      close(false);
      save();
      epoch++;
      void tree?.close();
      tree = null;
      levels = new Map();
      expanded = new Set();
      treeScroll = 0;
      pendingTreeScroll = null;
      for (const tab of tabs) dispose(tab);
      tabs = [];
      active = null;
      tablist.replaceChildren();
      views.replaceChildren();
      rootPath = '';
      status.textContent = '';
    }
    function seed() {
      const configured = state.config?.rootDirectory;
      if (!configured) return;
      if (rootPath === configured && tree) return;
      clear();
      rootPath = configured;
      const generation = epoch;
      let saved = {};
      try {
        saved = JSON.parse(localStorage.getItem(storeKey()) || '{}') || {};
      } catch {}
      setReadingWidth(Number(saved.readingWidth) >= 360 ? Number(saved.readingWidth) : null);
      const inside = (path) =>
        typeof path === 'string' &&
        (path === rootPath || path.startsWith(rootPath.replace(/\/$/, '') + '/'));
      expanded = new Set([
        rootPath,
        ...(Array.isArray(saved.expanded) ? saved.expanded.filter(inside).slice(0, 128) : []),
      ]);
      treeScroll = Number(saved.scrollTop) || 0;
      pendingTreeScroll = treeScroll;
      treePath.textContent = rootPath;
      treePath.title = rootPath;
      const load = async (path, signal) => {
        const previous = levels.get(path);
        if (!previous?.data) {
          levels.set(path, { loading: true });
          renderTree();
        }
        try {
          const data = await request(urlFor('list', path), { signal });
          if (signal.aborted || generation !== epoch) return;
          // Polling identical levels must not replace focused rows or selection.
          if (data.revision !== previous?.data?.revision || previous?.error) {
            levels.set(path, { data });
            renderTree();
          }
          return data;
        } catch (error) {
          if (signal.aborted || generation !== epoch) return;
          levels.set(path, { data: previous?.data, error: error.message });
          renderTree();
        }
      };
      async function* watch(path, signal) {
        yield 'ready';
        while (!signal.aborted) {
          await delay(signal);
          if (signal.aborted) return;
          if (visibleTree()) yield 'change';
        }
      }
      tree = new root.HarnessDirectoryNode(
        rootPath,
        load,
        watch,
        (path, error) => {
          if (generation !== epoch) return;
          levels.set(path, { ...levels.get(path), error: error.message });
          renderTree();
        },
        life.signal,
        [...expanded],
      ).open();
      // Only paths/preferences persist. File contents always come from this server.
      tabs = (Array.isArray(saved.paths) ? saved.paths.filter(inside).slice(0, 12) : []).map(
        (path) => newTab(path),
      );
      active = tabs.find((tab) => tab.path === saved.active) || tabs[0] || null;
      renderTree();
      renderTabs();
    }
    function renderTree() {
      if (sidebar.hidden) return;
      const focused = document.activeElement?.closest('[data-tree-path]')?.dataset.treePath;
      const top = treeBody.scrollTop || treeScroll,
        fragment = document.createDocumentFragment();
      function note(host, text, retry) {
        const row = make('li', 'workspace-tree-note', text);
        if (retry) row.append(button('重试', retry, 'workspace-inline-action'));
        host.append(row);
      }
      function level(path, depth) {
        const list = make('ul', 'workspace-tree-level'),
          value = levels.get(path);
        list.setAttribute('role', depth ? 'group' : 'tree');
        if (!depth) list.setAttribute('aria-label', '根目录文件');
        if (value?.error) note(list, value.error, () => void tree.find(path)?.refresh());
        if (!value?.data) {
          if (!value?.error) {
            note(list, '正在读取目录…');
            list.setAttribute('aria-busy', 'true');
          }
          return list;
        }
        if (!value.data.entries.length) note(list, '此目录为空。');
        const query = document.querySelector('#chatPickerSearch').value.trim().toLowerCase();
        let matches = 0;
        for (const entry of orderEntries(value.data.entries)) {
          const file = childPath(path, entry.name),
            directory = entry.type === 'directory',
            open = expanded.has(file);
          // Keep directories navigable while filtering already loaded file names.
          if (query && !directory && !entry.name.toLowerCase().includes(query)) continue;
          matches++;
          const item = make('li', 'workspace-tree-item');
          item.setAttribute('role', 'none');
          const row = button(
            '',
            () => (directory ? toggle(path, file) : openFile(file)),
            'workspace-tree-row',
          );
          row.dataset.treePath = file;
          row.title = file;
          row.setAttribute('role', 'treeitem');
          row.setAttribute('aria-level', String(depth + 1));
          row.style.setProperty('--tree-depth', depth);
          if (directory) row.setAttribute('aria-expanded', String(open));
          else row.setAttribute('aria-selected', String(active?.path === file));
          row.disabled = entry.type === 'other';
          if (row.disabled) row.title = `${file}：此类型无法在这里打开。`;
          row.append(icon(directory, open), make('span', 'workspace-tree-name', entry.name));
          item.append(row);
          if (directory && open) item.append(level(file, depth + 1));
          list.append(item);
        }
        if (query && value.data.entries.length && !matches) {
          const row = make('li', 'workspace-tree-note', '已加载的文件中没有匹配项。');
          row.append(
            button(
              '清除筛选',
              () => {
                const search = document.querySelector('#chatPickerSearch');
                search.value = '';
                search.dispatchEvent(new Event('input', { bubbles: true }));
                search.focus({ preventScroll: true });
              },
              'workspace-inline-action',
            ),
          );
          list.append(row);
        }
        if (value.data.truncated) note(list, '目录较大，仅显示前 2000 项。');
        return list;
      }
      if (rootPath) fragment.append(level(rootPath, 0));
      else fragment.append(make('p', 'workspace-tree-note', '正在连接文件目录…'));
      treeBody.replaceChildren(fragment);
      treeBody.scrollTop = top;
      if (
        pendingTreeScroll !== null &&
        [...expanded].every((path) => levels.get(path)?.data || levels.get(path)?.error)
      ) {
        treeBody.scrollTop = pendingTreeScroll;
        pendingTreeScroll = null;
      }
      treeScroll = pendingTreeScroll ?? treeBody.scrollTop;
      if (focused)
        [...treeBody.querySelectorAll('[data-tree-path]')]
          .find((row) => row.dataset.treePath === focused)
          ?.focus({ preventScroll: true });
    }
    function toggle(parent, path) {
      const node = tree?.find(parent);
      if (!node) return;
      if (expanded.has(path)) {
        expanded.delete(path);
        void node.collapse(path);
      } else {
        expanded.add(path);
        node.expand(path, [...expanded]);
      }
      tree.setExpanded([...expanded]);
      renderTree();
      save();
    }
    function showSidebar() {
      const visible = state.sidebarMode === 'files';
      const key = JSON.stringify([
        visible,
        state.config?.rootDirectory,
        document.querySelector('#chatPickerSearch').value,
      ]);
      sidebar.hidden = !visible;
      if (rootPath && rootPath !== state.config?.rootDirectory) clear();
      if (visible) {
        seed();
        if (sidebarKey !== key) renderTree();
      }
      sidebarKey = key;
    }
    function newTab(path) {
      const view = make('section', 'workspace-file-view');
      view.tabIndex = 0;
      view.setAttribute('role', 'tabpanel');
      const id = `workspace-file-${++newTab.nextId}`;
      view.id = id;
      view.setAttribute('aria-labelledby', `${id}-tab`);
      view.hidden = true;
      return {
        path,
        view,
        id,
        source: false,
        urls: [],
        controller: null,
        loaded: false,
        cleanup: null,
        entry: null,
        memory: null,
        editing: false,
        saving: false,
        editor: null,
        editNotice: null,
        feedback: '',
        markdown: null,
        renderGeneration: 0,
        codeLoading: false,
      };
    }
    newTab.nextId = 0;
    function renderTabs(shouldReveal = false) {
      const focused = document.activeElement?.id,
        previousScroll = tablist.scrollLeft;
      tablist.replaceChildren();
      for (const tab of tabs) {
        const box = make('div', 'workspace-file-tab');
        box.classList.toggle('selected', active === tab);
        box.classList.toggle('modified', Boolean(tab.entry && dirty(tab)));
        box.addEventListener('contextmenu', (event) => fileMenu(tab, event));
        box.addEventListener('auxclick', (event) => {
          if (event.button === 1) {
            event.preventDefault();
            removeTab(tab);
          }
        });
        box.addEventListener('mousedown', (event) => {
          if (event.button === 1) event.preventDefault();
        });
        const name = tab.path.split('/').pop();
        const select = button(name, () => selectTab(tab), 'workspace-file-select');
        select.id = `${tab.id}-tab`;
        select.title = tab.path;
        select.setAttribute('role', 'tab');
        select.setAttribute('aria-controls', tab.id);
        select.setAttribute('aria-haspopup', 'menu');
        select.setAttribute('aria-selected', String(active === tab));
        select.tabIndex = active === tab ? 0 : -1;
        const closeTabButton = button('×', () => removeTab(tab), 'workspace-file-close');
        closeTabButton.setAttribute('aria-label', `关闭 ${name}`);
        box.append(select, closeTabButton);
        tablist.append(box);
        if (!tab.view.isConnected) views.append(tab.view);
        tab.view.hidden = active !== tab;
      }
      tablist.scrollLeft = previousScroll;
      if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
      pathbar.replaceChildren();
      if (active) {
        const parts = active.path.slice(rootPath.length).split('/').filter(Boolean);
        pathbar.append(
          button(rootPath.split('/').pop() || '/', () => reveal(rootPath), 'workspace-path-part'),
        );
        let path = rootPath;
        for (let i = 0; i < parts.length; i++) {
          path = childPath(path, parts[i]);
          const target = path;
          pathbar.append(make('span', 'workspace-path-separator', '/'));
          pathbar.append(
            i < parts.length - 1
              ? button(parts[i], () => reveal(target), 'workspace-path-part')
              : make('span', 'workspace-path-name', parts[i]),
          );
        }
        pathbar.title = active.path;
      }
      updateTools();
      pathbar.scrollLeft = pathbar.scrollWidth;
      if (shouldReveal && active && shown) {
        const selected = document.getElementById(`${active.id}-tab`)?.parentElement;
        if (selected) {
          const item = selected.getBoundingClientRect(),
            list = tablist.getBoundingClientRect();
          if (item.right > list.right) tablist.scrollLeft += item.right - list.right;
          else if (item.left < list.left) tablist.scrollLeft += item.left - list.left;
        }
      }
    }
    function updateTools() {
      const tab = active,
        text = typeof tab?.entry?.text === 'string',
        busy = Boolean(tab?.controller || tab?.saving || tab?.codeLoading);
      mode.hidden = !text || tab.editing || !['markdown', 'html'].includes(tab.entry.kind);
      mode.textContent = tab?.source ? '预览' : '源码';
      mode.setAttribute('aria-pressed', String(Boolean(tab?.source)));
      mode.disabled = busy;
      edit.hidden = !text || tab.editing || tab.entry.editable !== true;
      edit.disabled = busy;
      commit.hidden = cancel.hidden = !tab?.editing;
      commit.disabled = !tab?.editing || busy || !dirty(tab);
      cancel.disabled = Boolean(tab?.saving || tab?.codeLoading);
      commit.textContent = tab?.saving ? '保存中…' : '保存';
      cancel.textContent = tab && dirty(tab) ? '取消' : '完成';
      copy.hidden = !text;
      copy.disabled = !text || Boolean(tab?.copying);
      outlineToggle.hidden = !tab?.markdown;
      outlineToggle.setAttribute('aria-expanded', String(Boolean(tab?.markdown?.expanded())));
      if (tab?.markdown) outlineToggle.setAttribute('aria-controls', tab.markdown.outlineId);
      else outlineToggle.removeAttribute('aria-controls');
      page.querySelector('.workspace-file-reload').disabled = busy;
    }
    function setReadingWidth(value) {
      readingWidth = value;
      if (value) page.style.setProperty('--workspace-markdown-width', `${value}px`);
      else page.style.removeProperty('--workspace-markdown-width');
    }
    async function discardAllowed(targets) {
      if (targets.some((tab) => tab.saving)) {
        status.textContent = '文件正在保存，请稍后核对结果。';
        return false;
      }
      const changed = targets.filter(dirty);
      if (!changed.length) return true;
      const generation = epoch,
        drafts = changed.map((tab) => tab.editor.generation);
      const confirmed = await askConfirm({
        title: '放弃未保存的修改？',
        message: changed.map((tab) => tab.path.split('/').pop()).join('、') + ' 的修改尚未保存。',
        confirmText: '放弃修改',
        danger: true,
      });
      return (
        confirmed &&
        generation === epoch &&
        changed.every(
          (tab, index) =>
            tabs.includes(tab) && !tab.saving && tab.editor?.generation === drafts[index],
        )
      );
    }
    function show() {
      if (!shown) {
        restoreFocus = document.activeElement;
        beforeOpen();
        shown = true;
        state.workspaceFilesOpen = true;
        page.hidden = false;
        // Keep chat mounted, with the same scroll geometry, while excluding it from keyboard focus.
        inert = [...page.parentElement.children]
          .filter((node) => node !== page)
          .map((node) => [node, node.inert]);
        for (const [node] of inert) node.inert = true;
      }
      closeDrawer();
    }
    function close(focus = true) {
      if (!shown) return;
      closeMenu();
      save();
      shown = false;
      state.workspaceFilesOpen = false;
      page.hidden = true;
      for (const [node, previous] of inert) node.inert = previous;
      inert = [];
      if (focus && restoreFocus?.isConnected && !restoreFocus.closest('[hidden]'))
        restoreFocus.focus({ preventScroll: true });
      onClose?.();
    }
    function selectTab(tab) {
      closeMenu();
      if (active !== tab) {
        clearTimeout(copy._copyTimer);
        delete copy.dataset.copyState;
        copy.setAttribute('aria-label', '复制全文');
      }
      active = tab;
      show();
      renderTabs(true);
      renderTree();
      if (!tab.loaded && !tab.controller) void loadFile(tab);
      tab.editor?.measure();
      tab.view.focus({ preventScroll: true });
      save();
    }
    function openFile(path) {
      seed();
      let tab = tabs.find((tab) => tab.path === path);
      if (!tab) {
        if (tabs.length >= 12) {
          selectTab(active || tabs[0]);
          status.textContent = '已打开 12 个文件，请点击标签旁的 × 关闭部分文件后再打开。';
          return;
        }
        tab = newTab(path);
        tabs.push(tab);
      }
      selectTab(tab);
    }
    function removeTab(tab) {
      removeTabs([tab]);
    }
    async function removeTabs(targets) {
      closeMenu();
      if (!(await discardAllowed(targets))) return;
      const index = tabs.indexOf(active),
        removed = new Set(targets);
      const next = removed.has(active)
        ? tabs.slice(index + 1).find((tab) => !removed.has(tab)) ||
          tabs
            .slice(0, index)
            .reverse()
            .find((tab) => !removed.has(tab)) ||
          null
        : active;
      for (const tab of tabs)
        if (removed.has(tab)) {
          dispose(tab);
          tab.view.remove();
        }
      tabs = tabs.filter((tab) => !removed.has(tab));
      active = next;
      if (!active) close();
      else selectTab(active);
      status.textContent = '';
      renderTabs();
      renderTree();
      save();
      if (active) document.getElementById(`${active.id}-tab`)?.focus({ preventScroll: true });
    }
    function closeMenu() {
      if (popovers.element?.classList.contains('workspace-file-menu')) popovers.close();
    }
    function fileMenu(tab, event, trigger) {
      if (!tab || !tabs.includes(tab)) return;
      event?.preventDefault();
      event?.stopPropagation();
      const index = tabs.indexOf(tab),
        generation = epoch;
      const selector = `#${tab.id}-tab`,
        control = trigger || document.querySelector(selector),
        box = control.getBoundingClientRect();
      const anchor = trigger
        ? { focus: () => trigger.focus({ preventScroll: true }) }
        : {
            contextElement: control.parentElement,
            contextScope: tablist,
            contextSelector: `.workspace-file-tab:has(${selector})`,
            focus: () => document.querySelector(selector)?.focus({ preventScroll: true }),
          };
      // The shared popover tracks a replaced tab button while file reads finish.
      const items = [
        { label: '关闭标签页', run: () => removeTab(tab) },
        {
          label: '关闭其他标签页',
          disabled: tabs.length < 2,
          run: () => removeTabs(tabs.filter((item) => item !== tab)),
        },
        {
          label: '关闭左侧标签页',
          disabled: index === 0,
          run: () => removeTabs(tabs.slice(0, tabs.indexOf(tab))),
        },
        {
          label: '关闭右侧标签页',
          disabled: index === tabs.length - 1,
          run: () => removeTabs(tabs.slice(tabs.indexOf(tab) + 1)),
        },
        { label: '关闭全部标签页', run: () => removeTabs([...tabs]) },
        { label: '复制完整路径', group: '文件', run: () => copyText(tab.path) },
        {
          label: '复制相对路径',
          run: () => copyText(tab.path.slice(rootPath.replace(/\/$/, '').length + 1)),
        },
        { label: '在文件目录中定位', run: () => revealFile(tab) },
        {
          label: '刷新文件',
          disabled: Boolean(tab.controller || tab.saving),
          run: () => reloadFile(tab),
        },
        { label: '保存原文件', run: () => download(tab) },
      ];
      popovers.open(anchor, {
        title: tab.path.split('/').pop(),
        className: 'workspace-file-menu',
        at: trigger
          ? { x: box.right, y: box.bottom }
          : event && (event.clientX || event.clientY)
            ? { x: event.clientX, y: event.clientY }
            : { x: box.left, y: box.bottom },
        items,
        onPick: async (item) => {
          if (generation !== epoch || !tabs.includes(tab) || !shown) return;
          anchor.focus();
          try {
            await item.run();
          } catch (error) {
            if (generation === epoch && shown)
              status.textContent = error.message || '文件操作失败，请重试。';
          }
        },
      });
    }
    async function revealFile(tab) {
      const generation = epoch;
      await reveal(tab.path.slice(0, tab.path.lastIndexOf('/')) || '/');
      if (generation !== epoch || !tabs.includes(tab)) return;
      const row = [...treeBody.querySelectorAll('[data-tree-path]')].find(
        (node) => node.dataset.treePath === tab.path,
      );
      row?.scrollIntoView({ block: 'nearest' });
      row?.focus({ preventScroll: true });
    }
    function dispose(tab) {
      tab.controller?.abort();
      tab.writeController?.abort();
      tab.controller = null;
      tab.cleanup?.();
      tab.cleanup = null;
      tab.markdown = null;
      tab.editor = null;
      tab.renderGeneration++;
      for (const url of tab.urls) URL.revokeObjectURL(url);
      tab.urls = [];
    }
    async function reloadFile(tab) {
      if (!(await discardAllowed([tab])) || !tabs.includes(tab)) return;
      tab.editing = false;
      tab.feedback = '';
      tab.loaded = false;
      await loadFile(tab);
    }
    async function loadFile(tab) {
      tab.controller?.abort();
      const controller = new AbortController();
      tab.controller = controller;
      tab.view.replaceChildren(make('p', 'workspace-file-status', '正在读取文件…'));
      tab.view.setAttribute('aria-busy', 'true');
      const generation = epoch,
        current = () => !controller.signal.aborted && generation === epoch && tabs.includes(tab);
      try {
        const entry = await request(urlFor('content', tab.path), { signal: controller.signal });
        if (!current()) return;
        tab.entry = entry;
        tab.loaded = true;
        await renderFile(tab, current, controller.signal);
      } catch (error) {
        if (!current()) return;
        tab.loaded = false;
        tab.view.replaceChildren(
          make('p', 'workspace-file-status', error.message),
          button('重试', () => void loadFile(tab), 'workspace-inline-action'),
        );
      } finally {
        if (current()) {
          tab.controller = null;
          tab.view.removeAttribute('aria-busy');
          renderTabs();
        }
      }
    }
    const docView = root.StudioDocView.createDocView({
      markdown: (source, resolve, image) =>
        root.StudioMarkdown.renderMarkdownWithLinks(source, resolve, { image }),
    });
    async function renderFile(tab, current = () => tabs.includes(tab), signal) {
      tab.cleanup?.();
      tab.cleanup = null;
      tab.markdown = null;
      tab.editor = null;
      tab.editNotice = null;
      const rendering = ++tab.renderGeneration;
      tab.view.classList.remove('workspace-file-code-view');
      for (const url of tab.urls) URL.revokeObjectURL(url);
      tab.urls = [];
      tab.view.replaceChildren();
      const doc = tab.entry,
        container = make('div', 'workspace-file-document');
      tab.view.append(container);
      if (typeof doc.text === 'string' && (tab.source || doc.kind === 'code')) {
        tab.view.classList.add('workspace-file-code-view');
        container.classList.add('workspace-code-surface');
        const footer = make('div', 'workspace-code-footer'),
          note = make('p', 'workspace-editor-notice', tab.feedback);
        note.setAttribute('role', 'status');
        tab.editNotice = note;
        const position = make('span', 'workspace-code-position');
        footer.append(note, position);
        tab.view.append(footer);
        let lastEdit = 0;
        tab.codeLoading = true;
        if (active === tab) updateTools();
        let editor;
        try {
          editor = await root.StudioFileCodeEditor.create({
            parent: container,
            text: normalized(doc.text),
            file: tab.path,
            size: doc.size,
            readOnly: !tab.editing || tab.saving,
            current: () => current() && tab.renderGeneration === rendering && container.isConnected,
            onSave: () => void saveFile(tab),
            onChange: (value) => {
              if (tab.renderGeneration !== rendering) return;
              if (value.generation !== lastEdit && !tab.saving) {
                tab.feedback = '';
                note.removeAttribute('data-error');
              }
              lastEdit = value.generation;
              position.textContent = `${value.line} 行，${value.column} 列 · UTF-8 · ${doc.text.includes('\r\n') ? 'CRLF' : 'LF'}`;
              document
                .getElementById(`${tab.id}-tab`)
                ?.parentElement.classList.toggle('modified', value.dirty);
              if (!tab.feedback)
                note.textContent = value.dirty ? '有未保存的修改。' : tab.editing ? '' : '只读';
              if (active === tab && tab.editor) updateTools();
            },
          });
        } finally {
          if (tab.renderGeneration === rendering) {
            tab.codeLoading = false;
            if (active === tab) updateTools();
          }
        }
        if (!editor) return;
        tab.editor = editor;
        tab.cleanup = () => editor.destroy();
        if (doc.truncated) note.textContent = '这份材料还有更多内容，编辑时将读取完整文件。';
        if (active === tab) renderTabs();
        return;
      }
      const localImage = (path, alt) => {
        const img = make('img', 'doc-image');
        img.alt = alt;
        img.loading = 'lazy';
        fetchBlob(urlFor('raw', path), { signal })
          .then((blob) => {
            if (!current() || !container.contains(img)) return;
            const url = URL.createObjectURL(blob);
            tab.urls.push(url);
            img.src = url;
          })
          .catch(() => {
            if (container.contains(img))
              img.replaceWith(make('span', 'workspace-file-status', `${alt || '图片'}：无法读取`));
          });
        return img;
      };
      const source = (target) => root.StudioCodeView.render(target, doc.text, tab.path);
      if (['image', 'pdf', 'audio', 'video'].includes(doc.kind)) {
        const blob = await fetchBlob(urlFor('raw', tab.path), { signal });
        if (!current()) return;
        const url = URL.createObjectURL(blob);
        tab.urls.push(url);
        const media = make(
          doc.kind === 'pdf' ? 'iframe' : doc.kind === 'image' ? 'img' : doc.kind,
          'workspace-file-media',
        );
        if (doc.kind === 'image') media.alt = tab.path.split('/').pop();
        if (doc.kind === 'pdf') {
          media.title = tab.path.split('/').pop();
          media.setAttribute('sandbox', '');
        }
        if (['audio', 'video'].includes(doc.kind)) media.controls = true;
        media.src = url;
        container.append(media);
      } else if (doc.kind === 'binary')
        container.append(make('p', 'workspace-file-status', '此文件无法预览，可以保存原文件。'));
      else if (doc.kind === 'html')
        tab.cleanup = root.StudioHtmlView.render(container, doc, {
          onOpen: openFile,
          renderSource: source,
        });
      else {
        docView.renderDoc(container, doc, {
          onOpen: openFile,
          image: localImage,
          rootDirectory: rootPath,
        });
        if (doc.kind === 'markdown') {
          tab.markdown = root.StudioFileMarkdown.create({
            view: tab.view,
            content: container,
            id: tab.id,
            onWidth: (value) => {
              setReadingWidth(value);
              save();
            },
            onOutline: (value) => {
              if (active === tab) outlineToggle.setAttribute('aria-expanded', String(value));
            },
          });
          tab.cleanup = () => tab.markdown?.close();
        }
      }
      if (active === tab) renderTabs();
    }
    async function beginEdit(tab) {
      if (!tab?.entry?.editable || tab.controller || tab.saving || tab.codeLoading || tab.editing)
        return;
      const generation = epoch;
      let reread = false;
      if (tab.entry.truncated) {
        const controller = new AbortController();
        tab.controller = controller;
        updateTools();
        try {
          const entry = await request(urlFor('content', tab.path) + '&full=1', {
            signal: controller.signal,
          });
          if (controller.signal.aborted || generation !== epoch || !tabs.includes(tab)) return;
          tab.entry = entry;
          reread = true;
        } catch (error) {
          if (generation === epoch && !controller.signal.aborted)
            status.textContent = error.message;
          return;
        } finally {
          if (tab.controller === controller) tab.controller = null;
          updateTools();
        }
      }
      if (!tab.entry.revision) {
        status.textContent = '此执行端暂不支持文件编辑，请更新后重试。';
        return;
      }
      if (generation !== epoch || !tabs.includes(tab)) return;
      tab.editing = true;
      tab.feedback = '';
      status.textContent = '';
      if (['markdown', 'html'].includes(tab.entry.kind)) tab.source = true;
      if (tab.editor && !reread) {
        tab.editor.setReadOnly(false);
        updateTools();
        tab.editNotice.textContent = '';
      } else {
        try {
          await renderFile(tab);
        } catch (error) {
          if (generation === epoch && tabs.includes(tab)) {
            tab.editing = false;
            status.textContent = error.message;
            updateTools();
          }
          return;
        }
      }
      if (active === tab && shown) tab.editor?.focus();
    }
    const draftText = (tab) => {
      const text = tab.editor.getText();
      return tab.entry.text.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
    };
    async function saveFile(tab) {
      if (!tab?.editing || tab.saving || !dirty(tab)) return;
      const snapshot = tab.editor.snapshot(),
        text = draftText(tab);
      const generation = epoch,
        controller = new AbortController();
      tab.writeController = controller;
      tab.saving = true;
      if (active === tab) status.textContent = '';
      tab.feedback = '正在保存…';
      tab.editNotice.textContent = tab.feedback;
      tab.editNotice.removeAttribute('data-error');
      updateTools();
      try {
        const entry = await request(urlFor('content', tab.path), {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, revision: tab.entry.revision }),
        });
        if (generation !== epoch || !tabs.includes(tab)) return;
        tab.entry = entry;
        tab.editor.markSaved(snapshot);
        tab.feedback = dirty(tab) ? '有未保存的修改。' : '文件已保存。';
        tab.editNotice.textContent = tab.feedback;
      } catch (error) {
        if (generation !== epoch || !tabs.includes(tab)) return;
        tab.feedback = error.status
          ? error.message
          : '保存结果尚未确认，编辑内容已保留。请核对文件后再操作。';
        tab.editNotice.textContent = tab.feedback;
        tab.editNotice.setAttribute('data-error', '');
      } finally {
        tab.saving = false;
        tab.writeController = null;
        if (tabs.includes(tab)) renderTabs();
      }
    }
    async function cancelEdit(tab) {
      if (!tab || !(await discardAllowed([tab]))) return;
      tab.editing = false;
      tab.feedback = '';
      status.textContent = '';
      tab.editor.reset();
      tab.editor.setReadOnly(true);
      tab.editNotice.textContent = '只读';
      tab.editNotice.removeAttribute('data-error');
      updateTools();
    }
    async function copyEntire(tab) {
      if (!tab || typeof tab.entry?.text !== 'string') return;
      const generation = epoch;
      try {
        let text = tab.editing ? draftText(tab) : tab.entry.text;
        if (!tab.editing && tab.entry.truncated) {
          clearTimeout(copy._copyTimer);
          copy.dataset.copyState = 'pending';
          tab.copying = true;
          updateTools();
          const blob = await fetchBlob(urlFor('download', tab.path));
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            await blob.arrayBuffer(),
          );
        }
        if (generation === epoch && active === tab && tabs.includes(tab) && shown)
          await copyText(text, copy);
      } catch (error) {
        if (generation === epoch && active === tab)
          status.textContent = error.message || '全文读取失败，请下载文件后复制。';
      } finally {
        tab.copying = false;
        updateTools();
      }
    }
    async function reveal(path) {
      if (
        document.querySelector('#chatView').classList.contains('sidebar-collapsed') ||
        (innerWidth <= 760 && !document.querySelector('#chatSidebar').classList.contains('open'))
      )
        document.querySelector('#chatDrawerToggle')?.click();
      document.querySelector('#sidebarFiles').click();
      let current = rootPath;
      for (const part of path.slice(rootPath.length).split('/').filter(Boolean)) {
        const next = childPath(current, part);
        expanded.add(next);
        tree.setExpanded([...expanded]);
        const node = tree.find(current);
        if (node) await node.refresh();
        node?.expand(next, [...expanded]);
        current = next;
      }
      renderTree();
    }
    sidebar
      .querySelector('.workspace-tree-refresh')
      .addEventListener('click', () => void tree?.refreshTree());
    treeBody.addEventListener(
      'scroll',
      () => {
        treeScroll = treeBody.scrollTop;
      },
      { passive: true },
    );
    treeBody.addEventListener('keydown', (event) => {
      const row = event.target.closest('[data-tree-path]');
      if (!row) return;
      const rows = [...treeBody.querySelectorAll('[data-tree-path]:not(:disabled)')],
        index = rows.indexOf(row);
      const target = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 }[
        event.key
      ];
      if (target !== undefined) {
        event.preventDefault();
        rows[Math.max(0, Math.min(rows.length - 1, target))]?.focus();
      } else if (event.key === 'ArrowRight' && row.hasAttribute('aria-expanded')) {
        event.preventDefault();
        if (row.getAttribute('aria-expanded') === 'false') row.click();
        else rows[index + 1]?.focus();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (row.getAttribute('aria-expanded') === 'true') row.click();
        else
          rows
            .find(
              (item) =>
                item.dataset.treePath === row.dataset.treePath.split('/').slice(0, -1).join('/'),
            )
            ?.focus();
      }
    });
    page.querySelector('.workspace-files-back').addEventListener('click', () => close());
    page
      .querySelector('.workspace-files-sidebar')
      .addEventListener('click', () => document.querySelector('#chatDrawerToggle').click());
    page.querySelector('.workspace-file-reload').addEventListener('click', () => {
      if (active) void reloadFile(active);
    });
    edit.addEventListener('click', () => void beginEdit(active));
    commit.addEventListener('click', () => void saveFile(active));
    cancel.addEventListener('click', () => void cancelEdit(active));
    copy.addEventListener('click', () => void copyEntire(active));
    outlineToggle.addEventListener('click', () => active?.markdown?.toggle());
    mode.addEventListener('click', () => {
      if (active?.entry && !active.controller) {
        active.source = !active.source;
        void renderFile(active);
        renderTabs();
      }
    });
    page
      .querySelector('.workspace-file-menu-toggle')
      .addEventListener('click', (event) => fileMenu(active, event, event.currentTarget));
    async function download(tab) {
      if (!tab) return;
      const control = page.querySelector('.workspace-file-download');
      control.disabled = true;
      try {
        const blob = await fetchBlob(urlFor('download', tab.path));
        if (!tabs.includes(tab)) return;
        const url = URL.createObjectURL(blob),
          link = make('a');
        link.href = url;
        link.download = tab.path.split('/').pop();
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        if (tabs.includes(tab)) tab.view.append(make('p', 'workspace-file-status', error.message));
      } finally {
        control.disabled = false;
      }
    }
    page
      .querySelector('.workspace-file-download')
      .addEventListener('click', () => void download(active));
    tablist.addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey || event.metaKey || tablist.scrollWidth <= tablist.clientWidth + 1)
          return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        tablist.scrollLeft +=
          delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tablist.clientWidth : 1);
      },
      { passive: false },
    );
    tablist.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(active);
      if (event.key === 'Delete') {
        if (active) removeTab(active);
        return;
      }
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      if (tabs[next]) {
        selectTab(tabs[next]);
        document.getElementById(`${tabs[next].id}-tab`).focus();
      }
    });
    window.addEventListener('pagehide', () => {
      save();
      life.abort();
      for (const tab of tabs) dispose(tab);
    });
    window.addEventListener('beforeunload', (event) => {
      if (tabs.some(dirty) || tabs.some((tab) => tab.saving)) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) save();
      else if (visibleTree()) void tree?.refreshTree();
    });
    return { showSidebar, close, open: openFile, isOpen: () => shown };
  }
  root.StudioWorkspaceFiles = { create, orderEntries, childPath };
})(globalThis);
