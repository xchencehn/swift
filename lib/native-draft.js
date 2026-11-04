'use strict';
const crypto = require('node:crypto');
const Conversation = require('./conversation-state');
const { composerState, clearNativeComposer } = require('./native-composer');
const fail = (code, message) => Object.assign(new Error(message), { code, status: 409 });
class NativeDraft {
  constructor({ herdr, exactPane, operate, press, beforeWrite = async () => {} }) {
    Object.assign(this, { herdr, exactPane, operate, press, beforeWrite });
  }
  async handle(body) {
    if (!['prepare', 'clear'].includes(body?.action))
      throw fail('INVALID_DRAFT_ACTION', '未知草稿操作。');
    return this.operate(body.paneId, async () => {
      const pane = await this.exactPane(body.paneId);
      if (body.action === 'clear' || body.binding) Conversation.assertIdentity(pane, body, true);
      else if (
        pane.terminalId !== body.terminalId ||
        pane.runtimeId !== body.runtimeId ||
        (pane.agent?.session?.value || '') !== body.sessionId
      )
        throw fail('SESSION_CHANGED', '目标会话已改变，未移动草稿。');
      const provider = pane.agent?.label;
      if (!['codex', 'claude'].includes(provider))
        throw fail('UNSUPPORTED_PROVIDER', '当前会话不支持移动原生草稿。');
      const read = () => this.herdr.readPane(pane.paneId, { lines: 160, ansi: true, exact: true });
      const state = composerState(await read(), provider),
        binding = Conversation.binding(pane);
      if (!state.recognized)
        throw fail('NATIVE_INPUT_UNAVAILABLE', '未确认当前终端输入框，内容未清空。');
      const revision = crypto
        .createHash('sha256')
        .update(JSON.stringify([binding, state.input]))
        .digest('hex');
      if (body.action === 'prepare') {
        if (/\[(?:Pasted (?:Content|text)|Image #)\b/i.test(state.input))
          throw fail(
            'NATIVE_DRAFT_COLLAPSED',
            '终端草稿包含折叠粘贴或附件，尚不能完整读取；内容未清空。',
          );
        Conversation.assertIdentity(await this.exactPane(pane.paneId), { binding });
        const text =
          provider === 'codex'
            ? state.input
                .split('\n')
                .map((line, i) => (i ? line.replace(/^ {2}/, '') : line).trimEnd())
                .join('\n')
            : state.input;
        return { ok: true, paneId: pane.paneId, binding, revision, text };
      }
      if (!state.input) return { ok: true, cleared: true };
      if (body.revision !== revision)
        throw fail(
          'NATIVE_DRAFT_CHANGED',
          'herdr终端输入已改变，Swift中的副本已保留，终端未清空。',
        );
      await this.beforeWrite(pane);
      let firstRead = true;
      await clearNativeComposer({
        pane,
        herdr: this.herdr,
        exactPane: this.exactPane,
        press: this.press,
        screen: async () => {
          const raw = await read();
          if (firstRead && composerState(raw, provider).input !== state.input)
            throw fail('NATIVE_DRAFT_CHANGED', 'herdr终端输入已改变，终端未清空。');
          firstRead = false;
          return raw;
        },
      });
      return { ok: true, cleared: true };
    });
  }
}
module.exports = { NativeDraft };
