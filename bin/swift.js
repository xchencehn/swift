#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const { formatSummary } = require('../lib/server-info');
function localBase() {
  return (
    process.env.SWIFT_LOCAL_URL ||
    `http://127.0.0.1:${process.env.PORT || 8792}${process.env.SWIFT_BASE_PATH || '/swift'}`
  ).replace(/\/$/, '');
}
async function info() {
  const response = await fetch(localBase() + '/api/info', {
    headers: {
      'x-agent-studio-token':
        process.env.SWIFT_TOKEN || require('../lib/http/server-token').savedToken(),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error('无法读取 Swift 服务信息，请检查本机服务。');
  return response.json();
}
async function main(args = process.argv.slice(2)) {
  if (['--version', '-V'].includes(args[0])) {
    console.log(require('../package.json').version);
    return;
  }
  if (['--help', '-h', 'help'].includes(args[0])) {
    console.log('swift / swift info    显示服务摘要与连接链接\nswift terminal        打开原生终端');
    return;
  }
  if (args[0] === 'terminal') {
    const result = spawnSync(process.env.HERDR_BIN || 'herdr', ['--session', 'swift'], {
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  if (args[0] && !['info', 'status'].includes(args[0]))
    throw Error('开源版使用直连，请运行 swift info 查看连接链接。');
  let result;
  try {
    result = await info();
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
    if (
      spawnSync('systemctl', ['--user', 'start', 'swift.service'], {
        stdio: 'ignore',
        timeout: 15000,
      }).status !== 0
    )
      throw Error('请先安装并启动 Swift 服务。');
    for (let i = 0; i < 20; i++) {
      try {
        result = await info();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!result) throw Error('Swift 服务尚未就绪。');
  }
  console.log(args.includes('--json') ? JSON.stringify(result) : formatSummary(result));
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main, localBase };
