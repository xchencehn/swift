/**
 * 模型与推理档位：目录、当前设置、以及改它们的那几个菜单。
 *
 * ⚠️ **按会话的实际能力显现**，不做点了没反应的开关：不可改时给出原因而不是
 * 一个灰着的列表。档位逐模型不同（Codex 的部分模型才有 ultra），所以候选必须按
 * `model/list` 给的 `efforts` 动态渲染，不能写死一份枚举。
 *
 * ⚠️ 目录与当前设置多半就在手边（目录进程内缓存，设置随每次刷新一起到）。有就
 * 先画出来再后台核对 —— 每次都先闪一下「正在读取模型…」等于每次点开都要眨一次眼。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StudioAgentSettings = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const createId = () =>
    globalThis.crypto?.randomUUID?.() ||
    `settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  /**
   * @param {object} deps
   *   `settingsStore`  `state.settings` 那份字典，跨模块共享（输入框那边也要读它）。
   *   ⚠️ 不能叫 `settings`：段内有 `const [catalog, settings] = await …`，同名会把它
   *   遮蔽成 TDZ，而错误落在 async 里、连 pageerror 都不报，表现是菜单静静地打不开。
   *   `remember`  带 saving 保护的写入 —— 正在保存时不要用在途的旧值盖回去。
   */
  function create({
    state,
    els,
    UI,
    settingsStore,
    remember,
    openPopover,
    currentPopover,
    request,
    identity,
    reportError,
    onApplied,
    paneOf,
    saveDraft,
  }) {
    const chatCacheKey = () =>
      JSON.stringify([
        identity(),
        state.config?.rootDirectory,
        state.herdrRuntimeId,
        paneOf()?.runtimeId,
      ]);
    // 目录只有这里在用，所以归它自己，不占 state 的公共字段。
    const catalogCache = {};
    const catalogRequests = new Map(),
      writes = new Map(),
      versions = new Map();

    async function loadAgentCatalog(provider) {
      if (!provider || provider === 'shell') return null;
      if (catalogCache[provider]) return catalogCache[provider];
      if (catalogRequests.has(provider)) return catalogRequests.get(provider);
      const work = (async () => {
        try {
          const data = await request(`/api/agent-catalog?provider=${encodeURIComponent(provider)}`);
          catalogCache[provider] = data;
          return data;
        } catch {
          return null;
        } finally {
          catalogRequests.delete(provider);
        }
      })();
      catalogRequests.set(provider, work);
      return work;
    }

    /** 当前这一格 pane 的 provider(codex / claude / 终端)。 */
    function currentProvider() {
      const pane = paneOf();
      return UI.providerId ? UI.providerId(pane) : pane?.agent?.id || null;
    }

    // 按当前会话能力显示模型目录；不可更改时展示原因，不发送无效设置请求。
    async function openModelPopover(anchor) {
      const provider = currentProvider();
      if (!provider || provider === 'shell') {
        return openPopover(anchor, {
          title: 'Reasoning',
          items: [],
          emptyText: '这一格不是 agent',
        });
      }
      const paneId = state.chatPaneId;
      const version = state.selectionVersion;
      const target = chatCacheKey();

      let painted = null;
      /** 画一次菜单；内容与上次画的一样就不动，免得后台核对完又闪一下。 */
      const paint = (catalog, settings) => {
        const models = (catalog?.models || []).filter(
          (model) => provider !== 'claude' || model.primary,
        );
        const signature = JSON.stringify([
          models.map((m) => m.id),
          settings.model,
          settings.effort,
          settings.editable,
          settings.reason,
        ]);
        if (painted && painted.signature === signature && currentPopover() === painted.element)
          return;
        const at = document.querySelector('.agent-action[data-action="model"]') || anchor;
        const element =
          settings.editable !== true
            ? openPopover(at, {
                title: 'Model',
                items: [],
                emptyText: settings.reason || '当前设置暂不可修改',
              })
            : openPopover(at, {
                title: 'Model',
                items: models.map((model) => ({
                  id: model.id,
                  label: model.label,
                  aside: settings.model === model.id ? '✓' : '',
                  current: settings.model === model.id,
                })),
                emptyText: '拿不到模型目录',
                onPick: (item) =>
                  openEffortPopover(
                    at,
                    models.find((model) => model.id === item.id),
                    target,
                  ),
              });
        painted = { signature, element: element || currentPopover() };
        return painted.element;
      };

      // 模型目录和当前设置多半就在手边（目录进程内缓存，设置随每次刷新一起到）。
      // 有就先画出来：点开即见，而不是每次都先闪一下「正在读取模型…」再填。
      const cached = catalogCache[provider];
      const known = settingsStore[paneId];
      const placeholder =
        cached && known && known.editable !== undefined
          ? paint(cached, known)
          : openPopover(anchor, { title: 'Model', items: [], emptyText: 'Loading…' });

      const [catalog, settings] = await Promise.all([
        loadAgentCatalog(provider),
        request(`/api/agent-settings?pane=${encodeURIComponent(paneId)}`).catch(() => ({
          editable: false,
          reason: '无法读取当前会话设置',
        })),
      ]);
      // 期间换了会话，或者用户已经点进下一页、关掉了菜单 —— 都不要再往上画。
      if (paneId !== state.chatPaneId || version !== state.selectionVersion) return;
      if (currentPopover() !== placeholder && currentPopover() !== painted?.element) return;
      remember(paneId, settings);
      paint(catalog, settings);
    }

    async function applyAgentSettings(
      changes,
      target = chatCacheKey(),
      beforeApply = async () => {},
    ) {
      if (target !== chatCacheKey()) return;
      const pane = paneOf();
      const threadId = pane?.agent?.session?.value;
      if (!pane?.terminalId || (!threadId && currentProvider() !== 'codex')) {
        reportError('会话尚未就绪');
        return false;
      }
      versions.set(target, (versions.get(target) || 0) + 1);
      const paneId = pane.paneId;
      const rootDirectory = state.config?.rootDirectory,
        runtimeId = state.herdrRuntimeId,
        processRuntimeId = pane.runtimeId,
        terminalId = pane.terminalId;
      const writeKey = JSON.stringify([rootDirectory, runtimeId, target, processRuntimeId]);
      let entry = writes.get(writeKey);
      if (entry) {
        Object.assign(entry.desired, changes);
        entry.version++;
        settingsStore[paneId] = {
          ...settingsStore[paneId],
          requested: { ...entry.desired },
          saving: true,
          operation: writeKey,
        };
        onApplied();
        return entry.promise;
      }
      entry = { desired: { ...changes }, version: 1, confirmed: settingsStore[paneId] || {} };
      writes.set(writeKey, entry);
      const valid = () => {
        const live = (state.chatAgents || []).find((item) => item.paneId === paneId);
        return (
          state.config?.rootDirectory === rootDirectory &&
          state.herdrRuntimeId === runtimeId &&
          live?.terminalId === terminalId &&
          live?.runtimeId === processRuntimeId &&
          live?.agent?.session?.value === threadId
        );
      };
      settingsStore[paneId] = {
        ...entry.confirmed,
        requested: { ...entry.desired },
        saving: true,
        operation: writeKey,
      };
      onApplied();
      entry.promise = (async () => {
        try {
          await beforeApply();
          while (valid()) {
            const version = entry.version,
              desired = { ...entry.desired };
            const result = await request('/api/agent-settings', {
              method: 'POST',
              body: JSON.stringify({
                paneId,
                threadId,
                sessionId: threadId || '',
                terminalId,
                runtimeId,
                processRuntimeId,
                requestId: createId(),
                ...desired,
              }),
            });
            if (!valid()) return false;
            entry.confirmed = { ...entry.confirmed, ...result.settings };
            const saving = version !== entry.version;
            settingsStore[paneId] = {
              ...entry.confirmed,
              saving,
              requested: saving ? { ...entry.desired } : null,
              uncertain: false,
              operation: saving ? writeKey : null,
            };
            onApplied();
            if (!saving) return true;
          }
          return false;
        } catch (error) {
          if (valid()) {
            settingsStore[paneId] = {
              ...entry.confirmed,
              saving: false,
              requested: null,
              uncertain: error.deliveryUncertain !== false,
            };
            onApplied();
            if (target === chatCacheKey())
              reportError(error.message || '设置结果待确认，请重新打开设置核对。');
          }
          return false;
        } finally {
          writes.delete(writeKey);
          if (!valid() && settingsStore[paneId]?.operation === writeKey) {
            delete settingsStore[paneId];
            onApplied();
          }
        }
      })();
      return entry.promise;
    }

    function applyModelChoice(modelId, effortId, target) {
      return applyAgentSettings(
        { model: modelId, ...(effortId ? { effort: effortId } : {}) },
        target,
      );
    }

    function openEffortPopover(anchor, model, target = chatCacheKey()) {
      if (!model) return;
      if (!model.efforts?.length) return applyModelChoice(model.id, null, target);
      openPopover(anchor, {
        title: 'Reasoning',
        onBack: () => openModelPopover(anchor),
        backLabel: 'Model',
        items: model.efforts.map((effort) => ({
          id: effort.id,
          label: effort.id,
          aside:
            settingsStore[state.chatPaneId]?.effort === effort.id
              ? '✓'
              : effort.isDefault
                ? 'default'
                : '',
          current:
            settingsStore[state.chatPaneId]?.model === model.id &&
            settingsStore[state.chatPaneId]?.effort === effort.id,
        })),
        emptyText: '这个模型不支持推理档位',
        onPick: (item) => applyModelChoice(model.id, item.id, target),
      });
    }
    async function currentSettingsCatalog(anchor = els.commandInput) {
      const target = chatCacheKey();
      const paneId = state.chatPaneId;
      const cached = catalogCache[currentProvider()],
        known = settingsStore[paneId];
      if (cached && known?.editable && !known.uncertain)
        return { catalog: cached, settings: { ...known, ...known.requested }, target };
      const loading = openPopover(anchor, { title: 'Reasoning', items: [], emptyText: 'Loading…' });
      const [catalog, settings] = await Promise.all([
        loadAgentCatalog(currentProvider()),
        request(`/api/agent-settings?pane=${encodeURIComponent(paneId)}`),
      ]);
      if (target !== chatCacheKey() || currentPopover() !== loading) return null;
      remember(paneId, settings);
      if (!settings.editable) {
        openPopover(anchor, {
          title: 'Reasoning',
          items: [],
          emptyText: settings.reason || '当前会话不支持修改设置',
        });
        return null;
      }
      return { catalog, settings, target };
    }

    async function openCurrentEffort(anchor = els.commandInput) {
      try {
        const value = await currentSettingsCatalog(anchor);
        if (!value) return;
        const model = value.catalog?.models?.find((item) => item.id === value.settings.model);
        if (!model) return openModelPopover(anchor);
        openEffortPopover(anchor, model, value.target);
      } catch (error) {
        reportError(error.message);
      }
    }

    async function stepSetting(kind, direction) {
      if (currentProvider() !== 'codex') return false;
      const target = chatCacheKey(),
        paneId = state.chatPaneId;
      const [catalog, fresh] = await Promise.all([
        loadAgentCatalog(currentProvider()),
        settingsStore[paneId]?.editable && !settingsStore[paneId]?.uncertain
          ? Promise.resolve(settingsStore[paneId])
          : request(`/api/agent-settings?pane=${encodeURIComponent(paneId)}`),
      ]);
      if (target !== chatCacheKey()) return false;
      const settings = { ...fresh, ...settingsStore[paneId]?.requested };
      if (!settings.editable) throw new Error(settings.reason || '当前会话不支持修改设置。');
      remember(paneId, settings);
      const models = catalog?.models || [],
        modelIndex = models.findIndex((item) => item.id === settings.model);
      const model = models[modelIndex];
      if (!model) throw new Error('无法确定当前模型，未修改设置。');
      if (kind === 'model') {
        if (models.length < 2) return true;
        const next = models[(modelIndex + direction + models.length) % models.length];
        const effort =
          next.efforts.find((item) => item.id === settings.effort) ||
          next.efforts.find((item) => item.isDefault) ||
          next.efforts[0];
        return applyAgentSettings(
          { model: next.id, ...(effort ? { effort: effort.id } : {}) },
          target,
        );
      }
      const choices = model.efforts || [];
      let index = choices.findIndex((item) => item.id === settings.effort);
      if (index < 0) index = choices.findIndex((item) => item.isDefault);
      if (index < 0) throw new Error('无法确定当前推理强度，未修改设置。');
      const next = choices[index + direction];
      if (!next) return true;
      return applyAgentSettings({ effort: next.id }, target);
    }

    async function openSpeedPopover() {
      const value = await currentSettingsCatalog();
      if (!value) return;
      const model = value.catalog?.models?.find((item) => item.id === value.settings.model);
      if (!model) return openModelPopover(els.commandInput);
      openPopover(els.commandInput, {
        title: `${model.label} · 速度`,
        items: [
          { id: null, label: 'Standard' },
          ...(model.serviceTiers || []).map((tier) => ({
            id: tier.id,
            label: tier.name,
            sub: tier.description,
          })),
        ].map((item) => ({
          ...item,
          current:
            Object.hasOwn(value.settings, 'serviceTier') && value.settings.serviceTier === item.id,
        })),
        onPick: (item) => applyAgentSettings({ serviceTier: item.id }, value.target),
      });
    }

    async function openSkillsPopover() {
      const target = chatCacheKey();
      openPopover(els.commandInput, { title: 'Skills', items: [], emptyText: '正在读取 Skills…' });
      const data = await request(`/api/agent-skills?pane=${encodeURIComponent(state.chatPaneId)}`);
      if (target !== chatCacheKey() || !currentPopover()) return;
      openPopover(els.commandInput, {
        title: 'Skills',
        searchable: true,
        emptyText: data.errors?.length ? '部分 Skills 无法读取' : '当前目录没有可用的 Skill',
        items: data.skills.map((skill) => ({
          id: skill.path,
          label: skill.name,
          sub: skill.interface?.shortDescription || skill.shortDescription || skill.description,
        })),
        onPick: (item) => {
          if (target !== chatCacheKey()) return;
          // Native Codex recognizes explicit $skill-name mentions. The terminal
          // remains the owner of submission, steering, approvals and the queue.
          els.commandInput.value = `$${item.label} `;
          els.commandInput.focus();
          saveDraft();
        },
      });
    }

    return {
      loadAgentCatalog,
      currentProvider,
      openModelPopover,
      applyAgentSettings,
      applyModelChoice,
      openEffortPopover,
      currentSettingsCatalog,
      openCurrentEffort,
      openSpeedPopover,
      openSkillsPopover,
      stepSetting,
      revision: () => versions.get(chatCacheKey()) || 0,
    };
  }

  return { create };
});
