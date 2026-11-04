'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sdk =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  path.join(os.homedir(), 'Android/Sdk');
const tools = fs
  .readdirSync(path.join(sdk, 'build-tools'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .at(-1);
const apks = ['chat', 'terminal'].map((flavor) => {
  const directory = path.join(__dirname, `../../android/app/build/outputs/apk/${flavor}/release`);
  const name = fs
    .readdirSync(directory)
    .find((name) => name.endsWith('.apk') && !name.includes('unsigned'));
  if (!name) throw new Error(`Missing signed ${flavor} APK`);
  const file = path.join(directory, name);
  execFileSync(
    path.join(
      sdk,
      'build-tools',
      tools,
      process.platform === 'win32' ? 'apksigner.bat' : 'apksigner',
    ),
    ['verify', file],
    { stdio: 'pipe' },
  );
  const metadata = execFileSync(
    path.join(sdk, 'build-tools', tools, 'aapt'),
    ['dump', 'badging', file],
    { encoding: 'utf8' },
  );
  const version = metadata.match(/versionName='([^']+)'/)?.[1];
  if (version !== require('../../package.json').version)
    throw new Error(`${flavor} APK version ${version} differs from package.json`);
  return {
    flavor,
    version,
    file: path.relative(path.resolve(__dirname, '../..'), file),
    signatureVerified: true,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
});
fs.mkdirSync(path.join(__dirname, '../../artifacts/validation'), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, '../../artifacts/validation/android-apks.json'),
  JSON.stringify({ apks }, null, 2) + '\n',
);
console.log('Both release APK signatures verified.');
