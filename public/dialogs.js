'use strict';
window.StudioDialogs = {
  create({ api, appPath }) {
    const $ = (selector) => document.querySelector(selector);
    const dlg = {
      root: $('#chatDialog'),
      title: $('#chatDialogTitle'),
      body: $('#chatDialogBody'),
      error: $('#chatDialogError'),
      cancel: $('#chatDialogCancel'),
      extra: $('#chatDialogExtra'),
      confirm: $('#chatDialogConfirm'),
    };
    let dialogResolve = null;
    let dialogCleanup = null;

    function closeDialog(value) {
      const resolve = dialogResolve;
      dialogResolve = null;
      if (dialogCleanup) {
        dialogCleanup();
        dialogCleanup = null;
      }
      if (dlg.root.open) dlg.root.close();
      if (resolve) resolve(value);
    }

    if (dlg.root) {
      dlg.cancel.addEventListener('click', () => closeDialog(null));
      // Esc 关闭走的是 dialog 自己的 cancel 事件,也要把 Promise 兑现,否则调用方永远等下去
      dlg.root.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeDialog(null);
      });
    }

    function openDialog({
      title,
      build,
      onConfirm,
      confirmText = '确定',
      danger = false,
      extra = null,
      actions = [],
    }) {
      if (!dlg.root) return Promise.resolve(null);
      closeDialog(null);
      // 辅助动作(比如「新建目录」)排在取消与确定之间,三颗按钮同一行、一个视觉层级,
      // 否则它单独占一行,看着像另一个区块。
      dlg.extra.hidden = !extra;
      dlg.extra.onclick = null;
      if (extra) {
        dlg.extra.textContent = extra.text;
        dlg.extra.onclick = () =>
          extra.onClick({
            close: closeDialog,
            fail: (message) => {
              dlg.error.textContent = message;
              dlg.error.hidden = !message;
            },
          });
      }
      dlg.title.textContent = title;
      dlg.body.textContent = '';
      dlg.error.hidden = true;
      dlg.confirm.textContent = confirmText;
      dlg.confirm.disabled = false;
      dlg.confirm.classList.toggle('danger', danger);
      dlg.confirm.hidden = !onConfirm;
      // 纯菜单没有「确定」这一步,那颗按钮就叫「关闭」,别让人找不到出口
      dlg.cancel.textContent = onConfirm ? '取消' : '关闭';
      const fail = (message) => {
        dlg.error.textContent = message;
        dlg.error.hidden = !message;
      };
      const buttons = actions.map((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-btn' + (action.danger ? ' danger' : '');
        button.textContent = action.text;
        button.onclick = action.onClick;
        dlg.cancel.before(button);
        return button;
      });
      const cleanup = build(dlg.body, {
        close: closeDialog,
        fail,
        actions: buttons,
        confirm: ({ disabled = false, hidden = false, text = confirmText } = {}) => {
          dlg.confirm.disabled = disabled;
          dlg.confirm.hidden = hidden;
          dlg.confirm.textContent = text;
        },
        cancelText: (text) => {
          dlg.cancel.textContent = text;
        },
      });
      dialogCleanup = () => {
        cleanup?.();
        for (const button of buttons) button.remove();
      };
      dlg.confirm.onclick = onConfirm ? () => onConfirm({ close: closeDialog, fail }) : null;
      dlg.root.showModal();
      return new Promise((resolve) => {
        dialogResolve = resolve;
      });
    }

    /** 问一个名字。返回 trim 过的字符串,取消返回 null。 */
    function askText({ title, label = '', value = '', placeholder = '', confirmText = '确定' }) {
      let input;
      return openDialog({
        title,
        confirmText,
        build(body) {
          if (label) {
            const p = document.createElement('p');
            p.textContent = label;
            p.style.margin = '0';
            body.append(p);
          }
          input = document.createElement('input');
          input.type = 'text';
          input.setAttribute('aria-label', label || title);
          input.value = value;
          input.placeholder = placeholder;
          body.append(input);
          // ⚠️ 只在内容还没被动过、也没有选区时才摆光标。这个延时会和「全选之后输入」
          // 撞车：那一瞬内容还没变、但选区已经建立，只看内容会放行，于是选区被重置，
          // 新内容追加在旧内容后面而不是替换它。
          setTimeout(() => {
            input.focus();
            if (input.value === value && input.selectionStart === input.selectionEnd)
              input.select();
          }, 30);
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              dlg.confirm.click();
            }
          });
        },
        onConfirm({ close, fail }) {
          const next = input.value.trim();
          if (!next) return fail('名称不能为空。');
          close(next);
        },
      });
    }

    function askNewTab() {
      let input, kind;
      return openDialog({
        title: '新建 Tab',
        confirmText: '创建',
        build(body) {
          const field = (text) => {
            const label = document.createElement('label');
            label.className = 'chat-field';
            const caption = document.createElement('span');
            caption.textContent = text;
            label.append(caption);
            body.append(label);
            return label;
          };
          kind = document.createElement('select');
          for (const [value, text] of [
            ['codex', 'Codex'],
            ['shell', 'Shell'],
          ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            kind.append(option);
          }
          field('类型').append(kind);
          input = document.createElement('input');
          input.type = 'text';
          input.value = 'Codex';
          field('Tab 名称').append(input);
          const clearError = () => {
            if (input.value.trim()) {
              dlg.error.textContent = '';
              dlg.error.hidden = true;
            }
          };
          input.addEventListener('input', clearError);
          let defaultName = 'Codex';
          kind.addEventListener('change', () => {
            const nextName = kind.value === 'codex' ? 'Codex' : 'Shell';
            if (!input.value.trim() || input.value === defaultName) input.value = nextName;
            defaultName = nextName;
            clearError();
          });
          input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              dlg.confirm.click();
            }
          });
          const timer = setTimeout(() => {
            input.focus();
            if (input.value === 'Codex' && input.selectionStart === input.selectionEnd)
              input.select();
          }, 30);
          return () => clearTimeout(timer);
        },
        onConfirm({ close, fail }) {
          const label = input.value.trim();
          if (!label) return fail('名称不能为空。');
          close({ kind: kind.value, label });
        },
      });
    }

    /**
     * 多行文本。任务目标常常是几句话加一条判据，单行输入框装不下，
     * 硬塞进去会让人只写一个短语。允许为空：清空目标是合理操作。
     */
    function askLongText({
      title,
      label = '',
      value = '',
      placeholder = '',
      confirmText = '保存',
    }) {
      let input;
      return openDialog({
        title,
        confirmText,
        build(body) {
          if (label) {
            const p = document.createElement('p');
            p.textContent = label;
            p.style.margin = '0';
            body.append(p);
          }
          input = document.createElement('textarea');
          input.className = 'chat-dialog-textarea';
          input.rows = 6;
          input.value = value;
          input.placeholder = placeholder;
          body.append(input);
          // 同上：内容被改过、或者已经有选区，就不再摆光标 —— 否则会把刚建立的选区
          // 折叠到末尾，接着输入就成了追加。
          setTimeout(() => {
            input.focus();
            if (input.value === value && input.selectionStart === input.selectionEnd) {
              input.setSelectionRange(input.value.length, input.value.length);
            }
          }, 30);
        },
        // 这里不绑 Enter 提交：多行文本里回车就是换行。
        onConfirm({ close }) {
          close(input.value.trim());
        },
      });
    }

    /** 问一句是否。确认返回 true,取消返回 null。 */
    function askConfirm({ title, message = '', confirmText = '确定', danger = false }) {
      return openDialog({
        title,
        confirmText,
        danger,
        build(body) {
          if (!message) return;
          const p = document.createElement('p');
          p.textContent = message;
          p.style.margin = '0';
          body.append(p);
        },
        onConfirm({ close }) {
          close(true);
        },
      });
    }

    /**
     * 选一个目录。
     *
     * 🔑 起点默认是**当前选中会话的目录** —— 终端里新建工作区是先 cd 过去再建,
     * 「当前在看哪个会话」是聊天页里最接近那个意图的东西;选不出来才退回 home。
     * 一次只列一层 + 面包屑,与 DeepSeek Harness 的 directory-picker 一致:
     * 一次给整棵树在大目录下既慢又没人看得完。
     */
    function askDirectory({
      title,
      start = '',
      confirmText = '选这里',
      request = api,
      resolvePath = appPath,
    }) {
      let current = start;
      let toggleMkdir = () => {};
      // 隐藏目录一律不列。真要去 `.config` 这种地方做事,旁边就是终端 ——
      // 在这里加个开关只是给一个少见的场景留一颗常驻的按钮,不划算。
      return openDialog({
        title,
        confirmText,
        extra: { text: '新建目录', onClick: () => toggleMkdir() },
        build(body, { fail }) {
          const pathLine = document.createElement('div');
          pathLine.className = 'chat-path';
          const crumbs = document.createElement('div');
          crumbs.className = 'chat-crumbs';
          const list = document.createElement('div');
          list.className = 'chat-dir-list';
          body.append(crumbs, list, pathLine);

          const load = async (target) => {
            try {
              const query = target ? `?path=${encodeURIComponent(target)}` : '';
              const result = await request(resolvePath(`/api/fs/list${query}`));
              current = result.path;
              pathLine.textContent = result.path;
              crumbs.textContent = '';
              for (const crumb of result.crumbs) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'chat-crumb';
                button.textContent = crumb.name;
                button.addEventListener('click', () => load(crumb.path));
                crumbs.append(button);
              }
              list.textContent = '';
              const shown = result.entries.filter((entry) => !entry.hidden);
              if (!shown.length) {
                const empty = document.createElement('div');
                empty.className = 'chat-dir-empty';
                empty.textContent = result.entries.length
                  ? '这一层只有隐藏目录。'
                  : '这个目录下没有子目录。';
                list.append(empty);
              }
              for (const entry of shown) {
                const row = document.createElement('button');
                row.type = 'button';
                row.className = 'chat-dir';
                const icon = document.createElement('span');
                icon.className = 'chat-dir-icon';
                icon.textContent = '▸';
                const name = document.createElement('span');
                name.textContent = entry.name;
                row.append(icon, name);
                row.addEventListener('click', () => load(entry.path));
                list.append(row);
              }
              if (result.truncated) {
                const note = document.createElement('div');
                note.className = 'chat-dir-empty';
                note.textContent = '子目录太多，只列出了前一部分。';
                list.append(note);
              }
              fail('');
            } catch (error) {
              fail(error.message || '读不了这个目录。');
            }
          };

          // 新建目录就地问名字:对话框只有一个壳,再开一层会把这层顶掉。
          const mkdirRow = document.createElement('div');
          mkdirRow.className = 'chat-dialog-actions';
          mkdirRow.style.justifyContent = 'stretch';
          mkdirRow.hidden = true;
          const mkdirInput = document.createElement('input');
          mkdirInput.type = 'text';
          mkdirInput.placeholder = '新目录名';
          mkdirInput.style.flex = '1';
          const mkdirOk = document.createElement('button');
          mkdirOk.type = 'button';
          mkdirOk.className = 'chat-btn primary';
          mkdirOk.textContent = '建';
          mkdirRow.append(mkdirInput, mkdirOk);
          body.append(mkdirRow);

          const submitMkdir = async () => {
            const name = mkdirInput.value.trim();
            if (!name) return;
            try {
              await request(resolvePath('/api/fs/mkdir'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ parent: current, name }),
              });
              mkdirInput.value = '';
              mkdirRow.hidden = true;
              load(current);
            } catch (error) {
              fail(error.message || '建不了这个目录。');
            }
          };
          mkdirOk.addEventListener('click', submitMkdir);
          mkdirInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitMkdir();
            }
          });
          toggleMkdir = () => {
            mkdirRow.hidden = !mkdirRow.hidden;
            if (!mkdirRow.hidden) mkdirInput.focus();
          };
          load(start);
        },
        onConfirm({ close }) {
          close(current);
        },
      });
    }

    /**
     * 菜单与对话框共用同一个外壳(chat-dialog),配色、字号、圆角、按钮形状
     * 都走同一套 —— 原来这两处各用一套样式,凑在一起就不像一个软件。
     */
    function openMenu({ title, build }) {
      return openDialog({
        title,
        confirmText: '',
        onConfirm: null,
        build(body, ctx) {
          const list = document.createElement('div');
          list.className = 'chat-menu';
          build((text, handler, danger) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chat-menu-item' + (danger ? ' danger' : '');
            button.textContent = text;
            button.addEventListener('click', () => {
              ctx.close(null);
              handler();
            });
            list.append(button);
          });
          body.append(list);
        },
      });
    }

    return {
      elements: dlg,
      close: closeDialog,
      open: openDialog,
      askText,
      askNewTab,
      askLongText,
      askConfirm,
      askDirectory,
      openMenu,
    };
  },
};
