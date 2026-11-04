'use strict';

const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const releaseBase = 'https://150.158.39.216:8002/desktop/';

function readRelease() {
  return new Promise((resolve, reject) => {
    const request = https.get(
      releaseBase + 'server-latest.json',
      {
        ca: [
          ...tls.rootCertificates,
          fs.readFileSync(path.join(__dirname, '../deploy/windows/update-root.crt')),
        ],
        agent: new https.Agent({ proxyEnv: process.env }),
        signal: AbortSignal.timeout(15000),
      },
      (response) => {
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
    downloadUrl: releaseBase + release.filename,
    sha256: release.sha256,
  };
}

module.exports = { check, readRelease };
