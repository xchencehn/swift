'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { fixture } = require('./message-rewind-fixture');

const source = path.resolve(__dirname, '../..');
const textOf = (message) =>
  message.sourceText ??
  (message.blocks || [])
    .filter((block) => block.kind === 'text')
    .map((block) => block.text)
    .join('\n');
const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function stop(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let timer;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Isolated Swift did not stop')), 10000);
      }),
    ]);
  } catch (error) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function run(output) {
  output = path.resolve(output);
  return fixture(output, async (f) => {
    // Codex creates its first rollout lazily, after the first user message.
    // Bootstrap only this independent fixture, then exercise the real HTTP path.
    const seed = [
      'HTTP PREFIX 保留原始消息',
      'HTTP MIDDLE 中文第一行\n第二行保留  两个空格。',
      'HTTP SUFFIX 将被回退',
    ];
    await f.send(seed[0]);
    await f.bindSession();
    const originalPane = await f.exactPane();
    const sessionId = originalPane.agent.session.value;
    const runtimeId = (await f.herdr.dashboard()).runtimeId;
    const token = 'isolated-http-native-token';
    const environment = f.herdr.env({
      HOST: '127.0.0.1',
      PORT: '0',
      HERDR_SESSION: f.herdr.session,
      HERDR_SOCKET_PATH: f.herdr.socketPath,
      SWIFT_ROOT_DIR: f.home,
      SWIFT_DATA_DIR: path.join(f.home, 'swift-http-data'),
      SWIFT_SETTINGS_FILE: path.join(f.home, 'swift-http-settings.json'),
      SWIFT_MACHINES_FILE: path.join(f.home, 'swift-http-machines.json'),
      SWIFT_DIRECT_AUTH: 'token',
      SWIFT_TOKEN: token,
      SWIFT_SESSION_CHILD: '1',
      SWIFT_HIDE_STARTUP_URLS: '1',
      SWIFT_BASE_PATH: '',
      SWIFT_MANAGEMENT_CONFIG: '',
    });
    assert.equal(environment.HOME, f.home);
    assert.equal(environment.CODEX_HOME, f.codeHome);
    assert.equal(environment.HERDR_SOCKET_PATH, f.herdr.socketPath);
    assert(f.herdr.socketPath.startsWith(f.home + path.sep));

    const child = fork(path.join(source, 'server.js'), [], {
      cwd: source,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const log = fss.createWriteStream(path.join(output, 'swift-server.log'));
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let tail = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        tail = (tail + chunk).slice(-16000);
      });
    const requests = [];
    let port;
    try {
      port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('Isolated Swift startup timeout: ' + tail)),
          20000,
        );
        const cleanup = () => {
          clearTimeout(timer);
          child.off('error', onError);
          child.off('exit', onExit);
          child.off('message', onMessage);
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(Error(`Isolated Swift stopped: ${code}/${signal}\n${tail}`));
        };
        const onMessage = (value) => {
          if (value.swiftSessionPort) {
            cleanup();
            resolve(value.swiftSessionPort);
          }
        };
        child.once('error', onError);
        child.once('exit', onExit);
        child.on('message', onMessage);
      });
      const base = `http://127.0.0.1:${port}`;
      const request = async (route, body) => {
        const response = await fetch(base + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'x-agent-studio-token': token,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30000),
        });
        const value = await response.json();
        requests.push({
          method: body === undefined ? 'GET' : 'POST',
          route,
          status: response.status,
          ...(body?.id ? { id: body.id } : {}),
          code: value.code || value.message?.error?.code || null,
          deliveryStatus: value.message?.status || null,
          rewindPhase: value.message?.rewindProgress?.phase || null,
        });
        assert(response.ok, JSON.stringify(value));
        return value;
      };
      const transcript = () =>
        request(
          `/api/transcript?pane=${encodeURIComponent(f.paneId)}&sessionId=${encodeURIComponent(sessionId)}&limit=60`,
        );
      for (let index = 1; index < seed.length; index++) {
        const before = f.requests.length;
        const value = await request('/api/messages', {
          id: `http-seed-${index}`,
          paneId: f.paneId,
          sessionId,
          text: seed[index],
        });
        assert.equal(value.message.status, 'dispatched', JSON.stringify(value.message));
        await f.wait(async () => {
          const history = await f.readHistory();
          return (
            f.requests.length === before + 1 &&
            history.targets.length === index + 1 &&
            history.targets.at(-1).sourceText === seed[index] &&
            (await f.text()).includes('ANSWER ' + (before + 1))
          );
        }, 'HTTP seed archive ' + index);
        await f.delay(180);
      }

      const before = await f.readHistory(),
        httpBefore = await transcript();
      assert.equal(before.complete, true);
      assert.equal(before.targets.length, 3);
      assert.deepEqual(
        httpBefore.messages
          .filter((message) => message.role === 'user')
          .map((message) => message.id),
        before.targets.map((target) => target.messageId),
      );
      const original = before.targets[1],
        beforeModels = f.requests.length;
      const target = {
        action: 'prepare',
        requestId: 'http-native-prepare',
        clientId: 'http-native-client',
        runtimeId,
        paneId: originalPane.paneId,
        terminalId: originalPane.terminalId,
        sessionId,
        messageId: original.messageId,
      };
      const prepared = await request('/api/agents/rewind', target);
      assert.equal(prepared.preparation.messageId, original.messageId);
      assert.equal(prepared.preparation.sourceText, seed[1]);
      assert.equal(
        (await request('/api/agents/rewind', target)).preparation.id,
        prepared.preparation.id,
      );
      await f.delay(200);
      const afterPrepare = await f.readHistory();
      assert.equal(afterPrepare.branch, before.branch);
      assert.equal(afterPrepare.revision, before.revision);
      assert.equal(f.requests.length, beforeModels);
      await f.capture('01-prepared');

      const editedText = 'HTTP EDITED 中文新内容\n新第二行保留  两个空格。';
      const body = {
        id: 'http-native-edit',
        paneId: f.paneId,
        sessionId,
        text: editedText,
        binding: httpBefore.binding,
        rewind: { preparationId: prepared.preparation.id },
      };
      const accepted = await request('/api/messages', body),
        receipt = accepted.message;
      assert.equal(receipt.status, 'dispatched', JSON.stringify(receipt));
      assert.equal(receipt.rewindProgress.phase, 'submitted');
      assert.equal(receipt.deliveryUncertain, false);
      assert.equal(receipt.retryable, false);
      assert(receipt.transportAcceptedAt != null);
      assert.equal(receipt.nativeUserMessageId ?? null, null);
      await f.wait(async () => {
        const history = await f.readHistory();
        return (
          history.targets.length === 2 &&
          history.targets.at(-1).sourceText === editedText &&
          f.requests.length === beforeModels + 1 &&
          (await f.text()).includes('ANSWER ' + (beforeModels + 1))
        );
      }, 'HTTP rewind full native archive');
      const after = await f.readHistory();
      assert.notEqual(after.branch, before.branch);
      assert.equal(after.targets[0].messageId, before.targets[0].messageId);
      assert.deepEqual(
        after.targets.map((target) => target.sourceText),
        [seed[0], editedText],
      );
      assert(
        !after.targets.some((target) =>
          [before.targets[1].messageId, before.targets[2].messageId].includes(target.messageId),
        ),
      );
      const httpAfter = await transcript(),
        httpUsers = httpAfter.messages.filter((message) => message.role === 'user');
      assert.deepEqual(
        httpUsers.map((message) => message.id),
        after.targets.map((target) => target.messageId),
      );
      assert.deepEqual(httpUsers.map(textOf), [seed[0], editedText]);
      await f.capture('02-reverted-sent');

      const modelCount = f.requests.length,
        branch = after.branch;
      const stored = await request(
        `/api/messages?pane=${encodeURIComponent(f.paneId)}&id=${body.id}`,
      );
      const { authoritative, ...storedReceipt } = stored.messages.find(
        (item) => item.id === body.id,
      );
      assert.equal(authoritative, true);
      assert.deepEqual(storedReceipt, receipt);
      const duplicate = await request('/api/messages', { ...body, retry: true });
      assert.deepEqual(duplicate.message, receipt);
      await f.delay(250);
      const final = await f.readHistory();
      assert.equal(f.requests.length, modelCount);
      assert.equal(final.branch, branch);
      assert.equal(final.revision, after.revision);
      const currentPane = await f.exactPane();
      assert.equal(currentPane.paneId, originalPane.paneId);
      assert.equal(currentPane.terminalId, originalPane.terminalId);
      assert.equal(currentPane.runtimeId, originalPane.runtimeId);
      assert.equal(currentPane.agent.session.value, sessionId);

      const files = [
        'server.js',
        'lib/message-queue.js',
        'lib/rewind-interaction.js',
        'lib/codex-rewind-native.js',
        'lib/codex-rewind-history.js',
        'lib/codex-lineage.js',
        'lib/http/routes/messages.js',
        'lib/http/routes/sessions.js',
      ];
      const sourceSha256 = Object.fromEntries(
        await Promise.all(
          files.map(async (name) => [name, hash(await fs.readFile(path.join(source, name)))]),
        ),
      );
      const report = {
        ok: true,
        at: new Date().toISOString(),
        isolatedSwiftProcessId: child.pid,
        isolatedHome: f.home,
        sourceDirectory: source,
        sourceSha256,
        actualHttpNativeIntegration: true,
        ordinaryHttpMessages: seed.length - 1,
        fixtureBootstrapMessages: 1,
        prepareReadOnly: { historyUnchanged: true, modelRequestsUnchanged: true, idempotent: true },
        rewind: {
          stableMessageId: original.messageId,
          prefixMessageId: after.targets[0].messageId,
          newMessageId: after.targets[1].messageId,
          submitted: true,
          fullChainPrefixPreserved: true,
          suffixDiscarded: true,
        },
        receipt: {
          status: receipt.status,
          phase: receipt.rewindProgress.phase,
          type: receipt.rewindProgress.receipt?.type,
          nativeUserMessageId: receipt.nativeUserMessageId ?? null,
          getPreserved: true,
          duplicateNoReplay: true,
        },
        nativeIdentityPreserved: true,
        modelRequestCount: f.requests.length,
        models: [...new Set(f.requests.map((value) => value.model))],
        httpRequests: requests,
        productionInput: false,
        externalInference: false,
      };
      await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      return report;
    } catch (error) {
      await fs.writeFile(
        path.join(output, 'http-failure.json'),
        JSON.stringify(
          { error: error.stack, isolatedSwiftProcessId: child.pid, port, requests, stderr: tail },
          null,
          2,
        ) + '\n',
      );
      throw error;
    } finally {
      await stop(child);
      await new Promise((resolve) => log.end(resolve));
    }
  });
}

module.exports = { run };
if (require.main === module)
  run(path.resolve(process.argv[2] || 'artifacts/message-rewind/http-native'))
    .then((report) =>
      console.log(
        JSON.stringify({
          ok: report.ok,
          ordinaryHttpMessages: report.ordinaryHttpMessages,
          modelRequestCount: report.modelRequestCount,
          receipt: report.receipt,
        }),
      ),
    )
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
