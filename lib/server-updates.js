'use strict';

const https = require('node:https');
const releaseBase = 'https://github.com/xchencehn/swift/releases/';

function readRelease(
  url = releaseBase + 'latest/download/server-latest.json',
  redirects = 0,
  signal = AbortSignal.timeout(15000),
) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: new https.Agent({ proxyEnv: process.env }),
        signal,
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          const location = new URL(response.headers.location || '', url);
          if (location.protocol !== 'https:' || redirects >= 5) {
            reject(new Error('服务器更新下载地址无效。'));
            return;
          }
          readRelease(location.href, redirects + 1, signal).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('服务器更新清单暂时不可用，请稍后重试。'));
          return;
        }
        let bytes = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) response.destroy(new Error('服务器更新清单无效。'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('服务器更新清单无效。'));
          }
        });
      },
    );
    request.on('error', reject);
  });
}

async function check({ version = require('../package.json').version, read = readRelease } = {}) {
  const release = await read();
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    release.filename !== `swift-${release.version}-server.tar.gz` ||
    !/^[a-f0-9]{64}$/.test(release.sha256)
  )
    throw new Error('服务器更新清单无效。');
  const current = version.split('.').map(Number),
    latest = release.version.split('.').map(Number);
  const difference =
    latest.map((value, index) => value - current[index]).find((value) => value !== 0) || 0;
  return {
    currentVersion: version,
    version: release.version,
    available: difference > 0,
    downloadUrl: `${releaseBase}download/v${release.version}/${release.filename}`,
    sha256: release.sha256,
  };
}

module.exports = { check, readRelease };
