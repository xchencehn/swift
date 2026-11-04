'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { runGuest } = require('./windows-vm');
const { createFixture } = require('./chat-harness');
async function main() {
  const version = require('../../package.json').version;
  const current = path.resolve(
    'desktop/target/x86_64-pc-windows-msvc/release/bundle/nsis',
    `Swift_${version}_x64-setup.exe`,
  );
  const fixture = await createFixture(),
    output = path.resolve(
      process.env.SWIFT_WINDOWS_OUTPUT ||
        'artifacts/testing/reliability-account-release/windows-install',
    );
  try {
    await runGuest({
      probe: true,
      fixtureUrl: fixture.url,
      output,
      installerSequence: [{ file: current, version }],
    });
    const result = JSON.parse(
      fs
        .readFileSync(path.join(output, 'native-install-result.json'), 'utf8')
        .replace(/^\uFEFF/, ''),
    );
    if (
      !result.ok ||
      result.sequence.length !== 4 ||
      result.rollbackMethod !== 'installed-executable-backup' ||
      result.finalVersion !== version
    )
      throw Error('Installer upgrade/rollback sequence is incomplete');
    console.log(JSON.stringify(result));
  } finally {
    await fixture.close();
  }
}
main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
