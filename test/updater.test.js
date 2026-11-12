import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { command, discover, updateAll, updateRepo, cleanError, installDependencies } from '../lib/updater.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yunzai-autoupdate-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('yunzai-autoupdate-'));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const remote = path.join(dir, 'remote.git');
  const source = path.join(dir, 'source');
  const target = path.join(dir, 'TRSS 空格目录');
  const git = (cwd, ...args) => command('git', args, { cwd });
  await git(dir, 'init', '--bare', remote);
  await git(dir, 'init', '-b', 'main', source);
  await git(source, 'config', 'user.name', 'Test User');
  await git(source, 'config', 'user.email', 'test@example.invalid');
  await git(source, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(source, 'file.txt'), 'original\n');
  await git(source, 'add', '.');
  await git(source, 'commit', '-m', 'initial');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-u', 'origin', 'main');
  await git(dir, '-c', 'core.autocrlf=false', 'clone', '-b', 'main', remote, target);
  await git(target, 'config', 'user.name', 'Test User');
  await git(target, 'config', 'user.email', 'test@example.invalid');
  await git(target, 'config', 'core.autocrlf', 'false');
  await fs.mkdir(path.join(target, 'plugins'));
  const publish = async (name, content, message = 'update') => {
    await fs.writeFile(path.join(source, name), content);
    await git(source, 'add', '.'); await git(source, 'commit', '-m', message);
    await git(source, 'push');
  };
  return { dir, source, target, remote, git, publish };
}

test('快进真实仓库，报告提交，依赖变化只在实际变化时标记', async t => {
  const f = await fixture(t);
  await f.publish('package.json', '{"name":"fixture"}\n', 'add dependencies');
  const updated = await updateRepo({ name: '本体', cwd: f.target });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.count, 1);
  assert.equal(updated.dependenciesChanged, true);
  assert.match(updated.commits[0], /add dependencies/);
  assert.equal((await updateRepo({ name: '本体', cwd: f.target })).status, 'unchanged');
});

test('保留本地修改，分叉分支失败时不生成合并提交', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.target, 'file.txt'), 'local change\n');
  await f.publish('file.txt', 'remote change\n');
  assert.equal((await updateRepo({ name: 'test', cwd: f.target })).status, 'skipped');
  assert.equal(await fs.readFile(path.join(f.target, 'file.txt'), 'utf8'), 'local change\n');
  await f.git(f.target, 'add', '.'); await f.git(f.target, 'commit', '-m', 'local commit');
  const before = await f.git(f.target, 'rev-parse', 'HEAD');
  const result = await updateRepo({ name: 'test', cwd: f.target });
  assert.equal(result.status, 'failed');
  assert.equal(await f.git(f.target, 'rev-parse', 'HEAD'), before);
});

test('识别 worktree .git 文件；跳过普通文件夹；插件失败仍更新本体', async t => {
  const f = await fixture(t);
  const linked = path.join(f.target, 'plugins', 'linked');
  await f.git(f.source, 'worktree', 'add', '-b', 'plugin-branch', linked);
  const broken = path.join(f.target, 'plugins', 'broken');
  await f.git(f.dir, 'init', broken);
  await fs.mkdir(path.join(f.target, 'plugins', 'plain'));
  const repos = await discover(f.target);
  assert.deepEqual(repos.map(repo => repo.name), ['broken', 'linked', 'TRSS-Yunzai']);
  await f.publish('file.txt', 'new body\n');
  const results = await updateAll(f.target);
  assert.equal(results[0].status, 'failed');
  assert.equal(results[1].status, 'skipped');
  assert.equal(results[2].status, 'updated');
});

test('无上游和 detached HEAD 均明确跳过；普通目录不能误更新父仓库', async t => {
  const f = await fixture(t);
  await f.git(f.target, 'branch', '--unset-upstream');
  assert.match((await updateRepo({ name: 'test', cwd: f.target })).detail, /上游/);
  await f.git(f.target, 'checkout', '--detach');
  assert.match((await updateRepo({ name: 'test', cwd: f.target })).detail, /detached/);
  const subdir = path.join(f.target, 'plugins');
  assert.match((await updateRepo({ name: 'test', cwd: subdir })).detail, /独立/);
});

test('错误消息隐藏 URL 凭据和 token', () => {
  const message = cleanError(new Error('https://name:password@example.invalid/repo?token=secret&ok=1'));
  assert.doesNotMatch(message, /password|secret/);
});

test('pnpm 调用兼容 Windows cmd 和 Unix 可执行文件，正确使用工作目录', async t => {
  const f = await fixture(t);
  const bin = path.join(f.dir, 'bin'); await fs.mkdir(bin);
  const win = process.platform === 'win32';
  const file = path.join(bin, win ? 'pnpm.cmd' : 'pnpm');
  await fs.writeFile(file, win ? '@echo off\r\necho PNPM_TEST_OK\r\necho ok>pnpm-ran.txt\r\n' : '#!/bin/sh\necho PNPM_TEST_OK\necho ok > pnpm-ran.txt\n', { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  assert.match(await installDependencies(f.target, 10), /PNPM_TEST_OK/);
  assert.equal((await fs.readFile(path.join(f.target, 'pnpm-ran.txt'), 'utf8')).trim(), 'ok');
});
