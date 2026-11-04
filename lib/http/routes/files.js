'use strict';

// 会话涉及的文件与目录浏览。目录一次只列一层，不回传整棵树。

const path = require('node:path');

function register(router, ctx) {
  const {
    currentRoot,
    exactPane,
    paneTranscriptFile,
    json,
    readJson,
    apiError,
    listDirectory,
    createDirectory,
  } = ctx;

  router.get(['/api/session-files', '/api/session-files/content'], async (req, res, url) => {
    const pane = await exactPane(url.searchParams.get('pane'));
    const sessionId = pane.agent?.session?.value;
    if (!sessionId || !['codex', 'claude'].includes(pane.agent?.label))
      return json(res, 200, {
        ok: true,
        paneId: pane.paneId,
        sessionId: sessionId || null,
        files: [],
      });
    if (url.searchParams.get('sessionId') !== sessionId)
      throw apiError(409, 'SESSION_CHANGED', '会话已改变，请重新打开文件列表。');
    let entries = [];
    try {
      entries = await currentRoot().sessionFiles.list(
        await paneTranscriptFile(pane),
        pane.agent.label,
        pane.baseCwd || pane.cwd || currentRoot().data.directory,
      );
    } catch (error) {
      if (!['ENOENT', 'TRANSCRIPT_NOT_FOUND'].includes(error.code)) throw error;
    }
    const result = url.pathname.endsWith('/content')
      ? {
          file: await currentRoot().sessionFiles.preview(
            entries,
            url.searchParams.get('id'),
            Number(url.searchParams.get('offset') || 0),
          ),
        }
      : { files: entries };
    const current = await exactPane(pane.paneId);
    if (current.agent?.session?.value !== sessionId || current.terminalId !== pane.terminalId)
      throw apiError(409, 'SESSION_CHANGED', '会话已改变，请重新打开文件列表。');
    return json(res, 200, { ok: true, paneId: pane.paneId, sessionId, ...result });
  });

  // 目录浏览:新建工作区/会话时要说清楚"建在哪个目录下"。终端里这件事是隐式的
  // (人先 cd 过去再建),聊天页里没有"当前目录"这个概念,只能显式选。
  // 一次只列一层 + 面包屑,不一次回传整棵树。
  router.get('/api/fs/list', async (req, res, url) => {
    try {
      return json(res, 200, {
        ok: true,
        ...(await listDirectory(url.searchParams.get('path') || '')),
      });
    } catch (error) {
      const code = error.code || 'FS_ERROR';
      return json(res, code === 'NOT_FOUND' ? 404 : 400, {
        ok: false,
        code,
        message: error.message,
      });
    }
  });

  router.post('/api/fs/mkdir', async (req, res, url) => {
    try {
      const payload = await readJson(req);
      const path = await createDirectory(payload.parent, payload.name);
      return json(res, 201, { ok: true, path, ...(await listDirectory(path)) });
    } catch (error) {
      const code = error.code || 'FS_ERROR';
      return json(res, 400, { ok: false, code, message: error.message });
    }
  });
}

module.exports = { register };
