#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function verifyPublicBase(source, revision, destination, receipt) {
  const head = git(destination, 'rev-parse', 'HEAD');
  let baseline = receipt?.publicRevision === head ? receipt.sourceRevision : undefined;
  if (!baseline) {
    const tree = git(destination, 'rev-parse', 'HEAD^{tree}');
    baseline = git(source, 'log', 'main', '--format=%H %T')
      .split('\n')
      .map((line) => line.split(' '))
      .find((entry) => entry[1] === tree)?.[0];
  }
  if (!baseline)
    throw new Error(
      'Public main has changes not registered in source main; integrate them before publishing.',
    );
  git(source, 'merge-base', '--is-ancestor', baseline, revision);
  return baseline;
}

// Copy one committed tree. Never copy the source repository's Git directory or ignored files.
function syncTree(source, revision, destination) {
  if (git(destination, 'status', '--porcelain')) throw new Error('Public checkout must be clean.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swift-public-tree-'));
  try {
    const archive = path.join(temporary, 'source.tar');
    git(source, 'archive', '--format=tar', `--output=${archive}`, revision);
    const extracted = path.join(temporary, 'source');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xf', archive, '-C', extracted]);
    const files = git(source, 'ls-tree', '-rz', '--name-only', revision)
      .split('\0')
      .filter(Boolean);
    const tracked = new Set(git(destination, 'ls-files', '-z').split('\0').filter(Boolean));
    for (const name of files) {
      if (
        /(^|\/)(\.git|\.local|node_modules|artifacts)(\/|$)/.test(name) &&
        name !== 'artifacts/.gitkeep'
      )
        throw new Error(`Private distribution input: ${name}`);
      const from = path.join(extracted, name);
      const stat = fs.lstatSync(from);
      if (stat.isSymbolicLink()) {
        let resolved;
        try {
          resolved = fs.realpathSync(from);
        } catch {
          resolved = '';
        }
        if (!resolved.startsWith(extracted + path.sep))
          throw new Error(`Public symbolic link must resolve inside the repository: ${name}`);
      } else if (!stat.isFile()) throw new Error(`Unsupported source entry: ${name}`);
      const target = path.join(destination, name);
      if (fs.existsSync(target) && !tracked.has(name))
        throw new Error(`Refusing to replace an ignored local file: ${name}`);
      for (let parent = path.dirname(target); parent !== destination; parent = path.dirname(parent))
        if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink())
          throw new Error(`Destination contains a symbolic-link directory: ${name}`);
      if (
        fs.existsSync(target) &&
        !fs.lstatSync(target).isFile() &&
        !fs.lstatSync(target).isSymbolicLink()
      )
        throw new Error(`Unexpected destination type: ${name}`);
    }
    for (const name of tracked) fs.rmSync(path.join(destination, name));
    for (const name of files) {
      const from = path.join(extracted, name),
        to = path.join(destination, name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.lstatSync(from).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
      else {
        fs.copyFileSync(from, to);
        fs.chmodSync(to, fs.statSync(from).mode & 0o777);
      }
    }
    const pathspec = path.join(temporary, 'tracked-paths');
    fs.writeFileSync(pathspec, files.join('\0') + '\0');
    git(destination, 'read-tree', '--empty');
    git(destination, 'add', '--force', `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul');
    const tree = git(destination, 'write-tree');
    if (tree !== git(source, 'rev-parse', `${revision}^{tree}`))
      throw new Error('Public tree differs from the committed source tree.');
    return { files: files.length, tree };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function main() {
  const { values } = require('node:util').parseArgs({
    options: {
      checkout: { type: 'string' },
      ref: { type: 'string', default: 'HEAD' },
      repository: { type: 'string', default: 'xchencehn/swift' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.checkout) {
    console.log(
      'Usage: npm run publish:github -- --checkout ABSOLUTE_PUBLIC_CHECKOUT [--ref COMMIT] [--dry-run]',
    );
    if (!values.help) process.exitCode = 2;
    return;
  }
  const source = path.resolve(__dirname, '../..');
  const destination = fs.realpathSync(values.checkout);
  if (destination === source) throw new Error('Use an independent public checkout.');
  const revision = git(source, 'rev-parse', '--verify', `${values.ref}^{commit}`);
  git(source, 'merge-base', '--is-ancestor', revision, 'main');
  const version = JSON.parse(git(source, 'show', `${revision}:package.json`)).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable release version is required.');
  const origin = git(destination, 'remote', 'get-url', 'origin');
  const expected = [
    `git@github.com:${values.repository}.git`,
    `https://github.com/${values.repository}.git`,
  ];
  if (!expected.includes(origin))
    throw new Error('Public origin does not match the selected GitHub repository.');
  if (git(destination, 'branch', '--show-current') !== 'main')
    throw new Error('Public checkout must use main.');
  const gitDirectory = git(destination, 'rev-parse', '--absolute-git-dir');
  const receipt = path.join(gitDirectory, 'swift-source.json');
  if (fs.existsSync(receipt))
    git(
      source,
      'merge-base',
      '--is-ancestor',
      JSON.parse(fs.readFileSync(receipt)).sourceRevision,
      revision,
    );
  if (values['dry-run']) {
    console.log(
      JSON.stringify(
        {
          repository: values.repository,
          sourceRevision: revision,
          version,
          tree: git(source, 'rev-parse', `${revision}^{tree}`),
          publicHead: git(destination, 'rev-parse', 'HEAD'),
        },
        null,
        2,
      ),
    );
    return;
  }
  const lock = path.join(gitDirectory, 'swift-publish.lock');
  fs.mkdirSync(lock);
  try {
    if (git(destination, 'status', '--porcelain'))
      throw new Error('Public checkout must be clean.');
    git(destination, 'fetch', 'origin', 'main');
    git(destination, 'merge', '--ff-only', 'origin/main');
    if (git(destination, 'rev-parse', 'HEAD') !== git(destination, 'rev-parse', 'origin/main'))
      throw new Error(
        'Resolve the existing unpushed public commit before synchronizing another source tree.',
      );
    verifyPublicBase(
      source,
      revision,
      destination,
      fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt)) : undefined,
    );
    const releases = JSON.parse(
      execFileSync('gh', ['api', `repos/${values.repository}/releases?per_page=100`], {
        encoding: 'utf8',
      }),
    );
    const published = releases.find((entry) => entry.tag_name === `v${version}` && !entry.draft);
    if (published) {
      const commit = JSON.parse(
        execFileSync('gh', ['api', `repos/${values.repository}/commits/v${version}`], {
          encoding: 'utf8',
        }),
      );
      if (commit.commit.tree.sha !== git(source, 'rev-parse', `${revision}^{tree}`))
        throw new Error(
          `Version ${version} is already published; increment the version before pushing new content.`,
        );
    }
    const result = syncTree(source, revision, destination);
    if (git(destination, 'diff', '--cached', '--name-only'))
      git(destination, 'commit', '-m', `Release Swift ${version}`);
    execFileSync('git', ['push', 'origin', 'main'], {
      cwd: destination,
      stdio: 'inherit',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND:
          process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
      },
    });
    const report = {
      repository: values.repository,
      version,
      sourceRevision: revision,
      publicRevision: git(destination, 'rev-parse', 'HEAD'),
      ...result,
    };
    fs.writeFileSync(receipt, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    fs.rmdirSync(lock);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { syncTree, verifyPublicBase };
