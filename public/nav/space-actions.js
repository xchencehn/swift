(function (root) {
  'use strict';
  const labels = { stop: '全部停止', restart: '全部重启', send: '一键发送' };
  const make = (tag, cls, text) => {
    const el = document.createElement(tag);
    el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  root.StudioSpaceActions = {
    create({ request, dialogs, refresh }) {
      return async function open(
        workspace,
        action,
        runtimeId,
        { showRecent = false, pane = null } = {},
      ) {
        let active = true,
          submitting = false,
          preview,
          targets = [],
          job,
          timer,
          input,
          controls,
          summary,
          list,
          detail;
        const label = pane ? '重启会话' : labels[action];
        const requestId = crypto.randomUUID();
        const render = () => {
          if (!active) return;
          const items = job?.items || targets;
          list.replaceChildren(
            ...items.map((item) => {
              const row = make('li', 'space-action-item');
              row.dataset.status = item.status || '';
              row.append(
                make('span', 'space-action-name', item.name),
                make(
                  'span',
                  'space-action-status',
                  item.message || (!item.available ? '暂时无法确认会话身份' : '等待执行'),
                ),
              );
              return row;
            }),
          );
          if (job) {
            const completed = items.filter(
              (i) => !['pending', 'running'].includes(i.status),
            ).length;
            const succeeded = items.filter((i) => i.status === 'succeeded').length;
            summary.textContent = pane
              ? job.done
                ? succeeded
                  ? '原会话已恢复。'
                  : '请查看以下重启结果。'
                : '正在退出并恢复原会话…'
              : job.done
                ? `已处理 ${items.length} 个会话，${succeeded} 个成功${succeeded < items.length ? `，${items.length - succeeded} 个需查看` : ''}。`
                : `正在处理 ${items.length} 个会话，已完成 ${completed} 个。`;
            controls.confirm({ hidden: true });
            controls.cancelText('关闭');
            detail.textContent = job.done
              ? '操作结果保留在 Space 菜单的“查看操作结果”中。'
              : '可以关闭此窗口。操作会继续，稍后可从 Space 菜单查看结果。';
          } else {
            summary.textContent = pane
              ? `仅重启 ${pane.name}，保留原 Tab 和会话记录。`
              : targets.length
                ? `${workspace.label} · ${targets.length} 个${action === 'stop' ? ' Agent' : ' Codex'} 会话`
                : `这个 Space 暂时没有已打开的${action === 'stop' ? ' Agent' : ' Codex'} 会话。`;
            controls.confirm({
              disabled: !targets.length || submitting,
              text: action === 'send' ? `发送到 ${targets.length} 个会话` : label,
            });
          }
        };
        const poll = async () => {
          if (!active || !job) return;
          try {
            const data = await request(
              `/api/spaces/actions?requestId=${encodeURIComponent(job.requestId)}`,
            );
            if (!active) return;
            job = data.job;
            controls.fail('');
            render();
            if (job.done) {
              void refresh();
              return;
            }
          } catch (error) {
            if (active) controls.fail('暂时无法读取结果，正在重新连接。操作不会重复提交。');
          }
          if (active) timer = setTimeout(poll, 1000);
        };
        const submit = async () => {
          if (!active || submitting || job || !targets.length || !preview) return;
          const text = input?.value.trim();
          if (action === 'send' && !text) {
            controls.fail('请输入要发送的消息。');
            input.focus();
            return;
          }
          submitting = true;
          controls.fail('');
          render();
          if (input) input.readOnly = true;
          const body = {
            requestId,
            action,
            workspaceId: workspace.workspaceId,
            runtimeId: preview.runtimeId,
            targets,
            ...(action === 'send' ? { text } : {}),
          };
          try {
            const data = await request('/api/spaces/actions', {
              method: 'POST',
              body: JSON.stringify(body),
            });
            job = data.job;
            if (!active) return;
            render();
            void poll();
          } catch (error) {
            // A lost response may have accepted the batch. Only read its receipt;
            // never create another request ID or automatically POST again.
            try {
              job = (
                await request(`/api/spaces/actions?requestId=${encodeURIComponent(requestId)}`)
              ).job;
              if (active) {
                render();
                void poll();
              }
            } catch {
              if (active) {
                controls.fail(
                  `${error.message || '操作结果尚未确认。'} 请从 Space 菜单查看操作结果后再决定是否重试。`,
                );
                controls.confirm({ hidden: true });
                controls.cancelText('关闭');
              }
            }
          }
        };
        return dialogs.open({
          title: showRecent
            ? `${workspace.label} · 操作结果`
            : `${pane?.name || workspace.label} · ${label}`,
          confirmText: label,
          onConfirm: submit,
          build(body, api) {
            controls = api;
            controls.confirm({ disabled: true });
            summary = make('p', 'space-action-summary', '正在读取会话…');
            summary.setAttribute('role', 'status');
            detail = make(
              'p',
              'space-action-detail',
              action === 'send'
                ? '发送给此 Space 内所有已打开的 Codex，包括正在执行和等待输入的会话。'
                : action === 'restart'
                  ? `${pane ? '先退出当前 Codex，再 resume 原会话，并' : '在原 Tab 中恢复原 Codex 会话，并'}继续未完成的 Goal。临时会话与终端中未发送的输入会随重启结束。`
                  : '向此 Space 的每个 Agent 发送 Esc，保留 Tab 和会话。',
            );
            list = make('ul', 'space-action-list');
            list.setAttribute('aria-label', '会话操作结果');
            body.append(summary, detail);
            if (action === 'send' && !showRecent) {
              input = make('textarea', 'chat-dialog-textarea');
              input.rows = 4;
              input.setAttribute('aria-label', '发送给所有 Codex 的消息');
              input.placeholder = '输入要同时发送的一句话…';
              body.append(input);
              setTimeout(() => {
                if (active) input.focus();
              }, 30);
            }
            body.append(list);
            (async () => {
              try {
                preview = await request(
                  `/api/spaces/actions?workspaceId=${encodeURIComponent(workspace.workspaceId)}${pane ? `&paneId=${encodeURIComponent(pane.paneId)}` : ''}`,
                );
                if (!active) return;
                if (preview.runtimeId !== runtimeId)
                  throw new Error('Herdr 已变化，请重新打开 Space 菜单。');
                targets = preview.targets.filter(
                  (t) =>
                    (action === 'stop' || t.provider === 'codex') &&
                    (!pane || t.paneId === pane.paneId),
                );
                if (pane) {
                  const recent = preview.recent;
                  if (recent && !recent.done) {
                    const item = recent.items[0];
                    if (
                      recent.action !== 'restart' ||
                      recent.items.length !== 1 ||
                      item.paneId !== pane.paneId ||
                      item.terminalId !== pane.terminalId ||
                      item.sessionId !== pane.sessionId
                    )
                      throw new Error(
                        '这个 Space 的其他操作仍在进行，请从 Space 菜单查看操作结果，完成后再重启。',
                      );
                    job = recent;
                    render();
                    void poll();
                    return;
                  }
                  const target = targets[0];
                  if (
                    !target ||
                    target.terminalId !== pane.terminalId ||
                    target.sessionId !== pane.sessionId
                  )
                    throw new Error('目标会话已变化，请刷新后重新打开 Agent 菜单。');
                  if (!target.available)
                    throw new Error('暂时无法确认此 Codex 的运行进程，请稍后重新打开菜单。');
                  if (!target.sessionId)
                    throw new Error(
                      '此 Codex 尚未建立会话记录，暂时无法 resume。请先发送一条消息，再重启会话。',
                    );
                }
                if (showRecent || (preview.recent && !preview.recent.done)) {
                  job = preview.recent;
                  if (!job) {
                    summary.textContent = '这个 Space 暂时没有操作记录。';
                    controls.confirm({ hidden: true });
                    return;
                  }
                  if (input) input.hidden = true;
                  render();
                  void poll();
                } else {
                  render();
                  if (action === 'stop' && targets.length) void submit();
                }
              } catch (error) {
                if (active) {
                  targets = [];
                  summary.textContent = pane
                    ? '暂时无法重启此会话。'
                    : '暂时无法读取此 Space 的会话。';
                  controls.fail(error.message);
                  controls.confirm({ hidden: true });
                }
              }
            })();
            return () => {
              active = false;
              clearTimeout(timer);
            };
          },
        });
      };
    },
  };
})(window);
