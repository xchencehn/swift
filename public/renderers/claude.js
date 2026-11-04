'use strict';

/**
 * Claude Code 的聊天流渲染器。
 *
 * 它比 Codex 多三种记录，都是终端上看得见、必须在网页上保留的：
 *
 * - `recap`：一轮结束时写的「这次做了什么、下一步是什么」。存档里是
 *   `type:system` / `subtype:away_summary`，正文在**顶层** content。标签照搬
 *   终端的写法不翻译 —— 它在两边指同一样东西。
 * ⚠️ 存档里还有一条 `turn_duration`（这一轮用了多久），**不要再把它合成消息**：
 *   终端上「用了多久、什么时候完的」只是完成那一瞬的状态行，随下一轮消失，对话
 *   正文里并不留下这么一条。合成出来等于凭空多出终端没有的东西。
 * - `error`：供应商侧的失败（限流、过载）。存档里是一条 assistant 记录，
 *   标着 isApiErrorMessage。它不是 Agent 说的话，混进回答里用户会以为模型
 *   真的这么回答了。
 *
 * Codex 一条都不产出，所以这三段逻辑留在这里，不要上移到公共件。
 */
(function (root) {
  const { renderBlocks, mark, renderQuestion } = root.StudioRendererCommon;

  root.StudioRenderers.register({
    harnessId: 'claude',
    label: 'Claude Code',
    schemaVersion: 1,
    renderMessage(message, bubble, host) {
      if (message.kind === 'error') {
        // 带上状态码，一眼分清是限流、过载还是别的。
        bubble.append(
          mark('chat-error-mark', message.status ? `接口错误 ${message.status}` : '接口错误'),
        );
      }
      if (message.kind === 'recap') bubble.append(mark('chat-recap-mark', 'recap'));
      bubble.append(...renderBlocks(message, host));
    },

    /**
     * Claude 的提问：`AskUserQuestion` 工具调用。
     *
     * 它是**分步**的：多问时终端显示 `Question n/m`，逐题回答，最后还有一个
     * review 阶段要再确认一次。表头照搬这个形状，用户在终端里见到的就是它。
     */
    renderQuestion(prompt, host) {
      return renderQuestion(prompt, host, {
        // 工具审批不是提问：表头写它要动的是什么（`Bash command`／`Edit file`…），
        // 照搬终端上那一行 —— 那正是判断该不该放行的依据。
        heading:
          prompt.toolId === 'permission'
            ? prompt.header || '需要你确认'
            : prompt.stage === 'review'
              ? 'Review your answers'
              : prompt.total > 1
                ? `Question ${(prompt.index ?? 0) + 1}/${prompt.total}`
                : 'Question',
        // Claude 的选项在终端里是带序号的一行，照这个样子。
        describeOption: (option, index) => `${index + 1}. ${option.label}`,
      });
    },
  });
})(typeof window === 'undefined' ? globalThis : window);
