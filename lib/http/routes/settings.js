'use strict';

// 根目录配置、设备设置、共享个人资料与服务健康。资料按根目录共享，设备设置按设备独立。

const fs = require('node:fs');
const os = require('node:os');

function register(router, ctx) {
  const {
    herdr,
    currentRoot,
    rootStates,
    rootSettings,
    stateFor,
    sockets,
    safeWsSend,
    json,
    readJson,
    apiError,
    securityHeaders,
    Profile,
    deviceId,
    publicControllerState,
    getLanBases,
    APP_NAME,
    BASE_PATH,
  } = ctx;

  router.get('/api/diagnostics/native', async (req, res, url) =>
    json(res, 200, {
      ok: true,
      ...((await ctx.nativeDiagnostics?.readRecent(
        Number(url.searchParams.get('limit') || 100),
      )) || { events: [] }),
    }),
  );

  // 资料与资料图片共用一次根目录解析：GET 读取，POST 保存。
  router.add(['GET', 'POST'], ['/api/profile', '/api/profile/image'], async (req, res, url) => {
    const body =
      req.method === 'POST' && url.pathname === '/api/profile' ? await readJson(req) : null;
    const rootDirectory =
      body?.rootDirectory || url.searchParams.get('rootDirectory') || currentRoot().data.directory;
    const data = rootStates.get(rootDirectory)?.data;
    if (!data) throw apiError(409, 'ROOT_CHANGED', '根目录尚未加载，请重试。');
    if (req.method === 'GET' && url.pathname === '/api/profile')
      return json(res, 200, { rootDirectory, profile: Profile.readProfile(data) });
    if (req.method === 'GET' && url.pathname === '/api/profile/image') {
      const result = await Profile.readProfileImage(
        data,
        url.searchParams.get('slot'),
        url.searchParams.get('id'),
      );
      res.writeHead(
        200,
        securityHeaders({
          'content-type': result.mime,
          'content-length': result.bytes.length,
          'cache-control': 'private, no-store',
          etag: result.etag,
        }),
      );
      return res.end(result.bytes);
    }
    if (req.method !== 'POST') throw apiError(405, 'METHOD_NOT_ALLOWED', '不支持的请求。');
    const profile =
      url.pathname === '/api/profile'
        ? Profile.saveProfile(data, body.profile)
        : await Profile.saveProfileImage(data, url.searchParams.get('slot'), req);
    if (data.directory === rootSettings.directory)
      for (const ws of sockets)
        safeWsSend(ws, { type: 'studio.profile.changed', rootDirectory, profile });
    return json(res, 200, { ok: true, rootDirectory, profile });
  });

  router.get('/api/health', async (req, res, url) => {
    const status = await herdr.status();
    return json(res, 200, {
      ok: true,
      service: 'swift',
      appName: APP_NAME,
      host: os.hostname(),
      now: new Date().toISOString(),
      herdr: { running: status.running, session: herdr.session || 'default' },
      management: ctx.getManagementStatus?.() || {
        configured: false,
        state: 'disabled',
        connected: false,
      },
      controllers: publicControllerState(),
    });
  });

  router.get('/api/config', async (req, res, url) => {
    return json(res, 200, {
      ok: true,
      service: 'swift',
      version: require('../../../package.json').version,
      appName: APP_NAME,
      role: 'execution',
      connectionMode:
        req.swiftPublicBase && req.swiftPublicBase !== BASE_PATH ? 'management' : 'direct',
      localApiBases: getLanBases().map((base) => `${base}${BASE_PATH}`),
      defaultCwd: currentRoot().data.directory,
      rootDirectory: currentRoot().data.directory,
      dataDirectory: currentRoot().data.path,
      deviceSettingsInitialized: fs.existsSync(
        currentRoot().data.file(`devices/${deviceId(req)}.json`),
      ),
      settings: currentRoot().data.deviceSettings(deviceId(req)),
      profile: Profile.readProfile(currentRoot().data),
      temporaryCwd: currentRoot().data.directory,
      herdrSession: herdr.session || 'default',
      basePath: req.swiftPublicBase ?? BASE_PATH,
      providerCapabilities: require('../../../public/provider-capabilities').all(),
      websocketPath: `${req.swiftPublicBase ?? BASE_PATH}/api/terminal`,
      terminalTransport: 'raw-pty',
      terminalChannelVersion: 1,
      terminalMultiplexVersion: 1,
    });
  });

  router.get('/api/server-update', async (req, res) => {
    try {
      return json(res, 200, await require('../../server-updates').check());
    } catch {
      throw apiError(502, 'UPDATE_CHECK_FAILED', '无法检查服务器更新，请稍后重试。');
    }
  });

  router.post('/api/config', async (req, res, url) => {
    const body = await readJson(req);
    const prepared = rootSettings.prepare(body.rootDirectory);
    stateFor(prepared); // Validate every store before publishing the new root.
    for (const id of new Set([
      deviceId(req),
      ...[...sockets].map((ws) => ws.deviceId || 'default'),
    ]))
      prepared.deviceSettings(id);
    const rootDirectory = rootSettings.update(body.rootDirectory, prepared);
    for (const ws of sockets)
      safeWsSend(ws, {
        type: 'studio.config.changed',
        rootDirectory,
        settings: prepared.deviceSettings(ws.deviceId || 'default'),
        profile: Profile.readProfile(prepared),
      });
    return json(res, 200, {
      ok: true,
      rootDirectory,
      dataDirectory: prepared.path,
      settings: prepared.deviceSettings(deviceId(req)),
      profile: Profile.readProfile(prepared),
      defaultCwd: rootDirectory,
      temporaryCwd: rootDirectory,
    });
  });

  router.post('/api/settings', async (req, res, url) => {
    const body = await readJson(req),
      data = rootStates.get(body.rootDirectory)?.data;
    if (!data) throw apiError(409, 'ROOT_CHANGED', '根目录尚未加载，请重试。');
    const id = deviceId(req),
      settings = data.saveDeviceSettings(id, body.settings);
    for (const ws of sockets)
      if (data.directory === rootSettings.directory && (ws.deviceId || 'default') === id)
        safeWsSend(ws, { type: 'studio.config.changed', rootDirectory: data.directory, settings });
    return json(res, 200, { ok: true, rootDirectory: data.directory, settings });
  });
}

module.exports = { register };
