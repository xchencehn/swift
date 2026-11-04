'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const versions = new Map(),
  catalogs = new Map();
async function installedVersion(provider, executable) {
  const key = `${provider}:${executable || provider}`;
  const cached = versions.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.version;
  const { stdout } = await execute(executable || provider, ['--version'], {
    timeout: 4000,
    maxBuffer: 4096,
  });
  const version = stdout.match(/\b\d+\.\d+\.\d+(?:-[\w.]+)?\b/)?.[0];
  if (!version) throw new Error('无法识别已安装版本');
  if (versions.size >= 64) versions.delete(versions.keys().next().value);
  versions.set(key, { version, at: Date.now() });
  return version;
}
function versionCatalog(provider, version) {
  if (!['codex', 'claude'].includes(provider) || !/^[\w.-]+$/.test(version)) return [];
  try {
    const data = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'data', 'commands', `${provider}-${version}.json`),
        'utf8',
      ),
    );
    return data.provider === provider && data.version === version ? data.commands : [];
  } catch {
    return [];
  }
}
// Initialize only: no user prompt, model turn or persisted conversation. Hooks
// and MCP startup are disabled. Native interactive commands come from the exact
// version's observed menu; the SDK adds this directory's actual skills/plugins.
function claudeCommands(cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DISABLE_AUTOUPDATER: '1' };
    delete env.CLAUDECODE;
    const child = spawn(
      'claude',
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--no-session-persistence',
        '--settings',
        '{"disableAllHooks":true}',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
      ],
      { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let buffer = '',
      size = 0,
      settled = false;
    const finish = (error, commands) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill();
      }
      error ? reject(error) : resolve(commands);
    };
    const timer = setTimeout(() => finish(new Error('读取 Claude 命令超时')), 12000);
    child.on('error', (error) => finish(error));
    child.on('close', () => finish(new Error('Claude 未返回命令目录')));
    child.stdin.on('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) return finish(new Error('命令目录过大'));
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          message.type !== 'control_response' ||
          message.response?.request_id !== 'command-catalog'
        )
          continue;
        const commands = message.response?.response?.commands;
        if (!Array.isArray(commands)) return finish(new Error('Claude 命令目录格式变化'));
        finish(
          null,
          commands.filter(
            (command) =>
              /^[\w][\w:.-]*$/.test(command.name) &&
              !command.name.startsWith('__') &&
              !['workflow-launch-exec'].includes(command.name),
          ),
        );
      }
    });
    child.stdin.end(
      JSON.stringify({
        type: 'control_request',
        request_id: 'command-catalog',
        request: { subtype: 'initialize' },
      }) + '\n',
    );
  });
}
async function readAgentCommands(provider, cwd, dependencies = {}) {
  const version = await (dependencies.version || installedVersion)(
    provider,
    dependencies.executable,
  );
  const key = `${provider}:${version}:${cwd}`;
  const cached = catalogs.get(key);
  if (!dependencies.version && cached && Date.now() - cached.at < 60000) return cached.promise;
  const promise = (async () => {
    const builtin = versionCatalog(provider, version);
    let local = [],
      reason = '';
    if (provider === 'claude') {
      try {
        local = await (dependencies.claude || claudeCommands)(cwd);
      } catch {
        reason = '项目命令暂时无法读取';
      }
    }
    // Web actions are backed by capabilities, not pinned to one CLI version.
    const actions =
      provider === 'codex'
        ? [
            'model',
            'effort',
            'fast',
            'skills',
            'compact',
            'new',
            'resume',
            'agents',
            'copy',
            'goal',
          ]
        : ['model', 'effort'];
    const commands = new Map(
      [...actions.map((name) => ({ name })), ...builtin].map((command) => [command.name, command]),
    );
    for (const command of local)
      commands.set(command.name, {
        name: command.name,
        description: command.description || '',
        argumentHint: command.argumentHint || '',
      });
    return {
      provider,
      version,
      source: dependencies.executable ? 'running-process-version' : 'installed-version',
      commands: [...commands.values()],
      ...(!builtin.length && !local.length
        ? { reason: '当前版本的内置命令目录尚未采集' }
        : reason
          ? { reason }
          : {}),
    };
  })();
  if (!dependencies.version) {
    if (catalogs.size >= 64) catalogs.delete(catalogs.keys().next().value);
    catalogs.set(key, { at: Date.now(), promise });
  }
  return promise;
}
module.exports = { readAgentCommands, versionCatalog, claudeCommands };
