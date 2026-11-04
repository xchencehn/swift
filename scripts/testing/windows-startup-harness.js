'use strict';
// Measure only the isolated Swift window in the attendance VM.
const fs = require('node:fs'),
  path = require('node:path'),
  { createHash } = require('node:crypto');
const { createFixture } = require('./chat-harness');
const { runGuest } = require('./windows-vm');
const { sourceFingerprint } = require('../lib/source-fingerprint');
async function main() {
  const root = path.resolve(__dirname, '../..');
  const executable = path.resolve(
    process.env.SWIFT_STARTUP_EXECUTABLE ||
      'desktop/target/x86_64-pc-windows-msvc/release/swift-desktop.exe',
  );
  const output = path.resolve(
    process.env.SWIFT_STARTUP_OUTPUT || 'artifacts/validation/windows-startup',
  );
  const source = sourceFingerprint(root);
  let build;
  if (!process.env.SWIFT_STARTUP_EXECUTABLE) {
    build = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/validation/windows-build.json')));
    const same = (value) =>
      value?.revision === source.revision &&
      value?.dirty === source.dirty &&
      value?.treeSha256 === source.treeSha256;
    if (!build.ok || !same(build.before) || !same(build.after))
      throw Error(
        'Startup validation requires a successful build of the current source. Run npm run validate -- desktop first.',
      );
  }
  const identity = {
    measurementSource: source,
    build,
    executable,
    sha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),
  };
  if (
    build &&
    (identity.sha256 !== build.executable?.sha256 ||
      !fs
        .readFileSync(executable)
        .includes(fs.readFileSync(path.join(root, 'desktop/dist/VERSION.json'))))
  )
    throw Error('The startup executable differs from the verified build.');
  const fixture = await createFixture();
  try {
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
    await runGuest({
      executable,
      fixtureUrl: fixture.url,
      fixtureToken: 'unused-startup',
      output,
      direct: true,
      startup: true,
    });
    const file = path.join(output, 'native-startup.json');
    const proof = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    proof.identity = identity;
    fs.writeFileSync(file, JSON.stringify(proof, null, 2) + '\n');
    for (const scenario of proof.scenarios)
      console.log(JSON.stringify({ ...scenario, samples: scenario.samples.length }));
    if (!proof.ok) throw Error('Windows startup did not produce content in every sample.');
  } finally {
    await fixture.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
