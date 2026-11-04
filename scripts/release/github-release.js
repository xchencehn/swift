#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const repository = process.env.GITHUB_REPOSITORY || 'xchencehn/swift';
function command(program, args) {
  return execFileSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}
function api(endpoint) {
  return JSON.parse(command('gh', ['api', `repos/${repository}/${endpoint}`]));
}
function verifyGate(revision, head, runs) {
  if (head !== revision)
    throw new Error('A newer main commit exists; release the current main instead.');
  const run = runs.find(
    (entry) =>
      entry.head_sha === revision && entry.event === 'push' && entry.head_branch === 'main',
  );
  if (!run || run.status !== 'completed' || run.conclusion !== 'success')
    throw new Error('The exact public commit must pass the complete CI workflow before release.');
  return run;
}
function prepareAssets(version, revision, previous) {
  command(process.execPath, ['scripts/release/package-release.js', '--server-only']);
  command(process.execPath, ['scripts/release/package-source.js']);
  const release = path.join(root, 'artifacts/release', version);
  const destination = path.join(release, 'github');
  fs.mkdirSync(destination, { recursive: true });
  for (const [directory, name] of [
    [release, 'server'],
    [path.join(release, 'source'), 'source'],
  ]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json')));
    if (manifest.revision !== revision || manifest.dirty)
      throw new Error('Release inputs do not match the committed source.');
    fs.copyFileSync(
      path.join(directory, 'manifest.json'),
      path.join(destination, `${name}-manifest.json`),
    );
    const filename = `swift-${version}-${name === 'server' ? 'server' : 'source'}.tar.gz`;
    fs.copyFileSync(path.join(directory, filename), path.join(destination, filename));
  }
  const latest = JSON.parse(fs.readFileSync(path.join(release, 'server-latest.json')));
  latest.revision = revision;
  latest.downloadUrl = `https://github.com/${repository}/releases/download/v${version}/${latest.filename}`;
  fs.writeFileSync(
    path.join(destination, 'server-latest.json'),
    JSON.stringify(latest, null, 2) + '\n',
  );
  fs.copyFileSync(
    path.join(root, 'deploy/github-install.py'),
    path.join(destination, 'github-install.py'),
  );
  const names = [
    'server-manifest.json',
    'source-manifest.json',
    'server-latest.json',
    'github-install.py',
    `swift-${version}-server.tar.gz`,
    `swift-${version}-source.tar.gz`,
  ];
  // A server-only release keeps the last independently verified desktop update discoverable.
  if (previous?.assets.some((asset) => asset.name === 'latest.json')) {
    command('gh', [
      'release',
      'download',
      previous.tag_name,
      '--repo',
      repository,
      '--pattern',
      'latest.json',
      '--dir',
      destination,
      '--clobber',
    ]);
    names.push('latest.json');
  }
  fs.writeFileSync(
    path.join(destination, 'SHA256SUMS'),
    names
      .map(
        (name) =>
          `${crypto
            .createHash('sha256')
            .update(fs.readFileSync(path.join(destination, name)))
            .digest('hex')}  ${name}\n`,
      )
      .join(''),
  );
  return [...names, 'SHA256SUMS'].map((name) => path.join(destination, name));
}
function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run release:github (from the clean public checkout after CI succeeds)');
    return;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository.');
  const revision = command('git', ['rev-parse', 'HEAD']);
  if (command('git', ['status', '--porcelain']))
    throw new Error('Release requires a clean committed checkout.');
  const { version } = require('../../package.json');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable version is required.');
  const run = verifyGate(
    revision,
    api('commits/main').sha,
    api(`actions/workflows/ci.yml/runs?head_sha=${revision}&per_page=100`).workflow_runs,
  );
  const releases = api('releases?per_page=100');
  const tag = `v${version}`;
  const existing = releases.find((release) => release.tag_name === tag);
  if (existing && !existing.draft) {
    if (existing.prerelease || api(`commits/${tag}`).sha !== revision)
      throw new Error('This version already exists with a different commit.');
    console.log(`Already published: ${existing.html_url}`);
    return;
  }
  if (existing && existing.target_commitish !== revision)
    throw new Error('A draft for this version belongs to a different commit.');
  const latest = releases.find((release) => !release.draft && !release.prerelease);
  if (latest && /^v\d+\.\d+\.\d+$/.test(latest.tag_name)) {
    const before = latest.tag_name.slice(1).split('.').map(Number),
      after = version.split('.').map(Number);
    if (
      (after.map((value, index) => value - before[index]).find((difference) => difference) || 0) <=
      0
    )
      throw new Error(
        'Increment the version; published releases are immutable and must not be downgraded.',
      );
  }
  const assets = prepareAssets(version, revision, latest);
  const notes = path.join(root, 'artifacts/release', version, 'github/notes.md');
  fs.writeFileSync(
    notes,
    `Swift ${version}\n\nSource: ${revision}\nCI: ${run.html_url}\n\nDownload the server or complete source archive and verify SHA256SUMS. Windows installers and Android APKs are attached separately after signing and platform validation.\n`,
  );
  if (existing)
    command('gh', ['release', 'upload', tag, '--repo', repository, '--clobber', ...assets]);
  else
    command('gh', [
      'release',
      'create',
      tag,
      '--repo',
      repository,
      '--target',
      revision,
      '--title',
      `Swift ${version}`,
      '--notes-file',
      notes,
      '--draft',
      ...assets,
    ]);
  const uploaded = api('releases?per_page=100').find((release) => release.tag_name === tag);
  if (!uploaded) throw new Error('The uploaded release draft could not be found.');
  for (const file of assets)
    if (
      !uploaded.assets.some(
        (asset) => asset.name === path.basename(file) && asset.size === fs.statSync(file).size,
      )
    )
      throw new Error('Release assets are incomplete; the release remains a draft.');
  // Recheck main after packaging and upload so an older job cannot become the latest release.
  if (api('commits/main').sha !== revision)
    throw new Error('Main advanced during packaging; the release remains a draft.');
  command('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest']);
  console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
}
if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { verifyGate };
