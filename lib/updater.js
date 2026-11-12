import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
const manifests = /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.ya?ml|\.npmrc|\.pnpmfile\.cjs)$/;

export function cleanError(error) {
  return String(error.stderr || error.message || error)
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/([?&](?:token|access_token|auth)=)[^\s&'"]+/gi, '$1***')
    .trim().slice(0, 500);
}

export async function command(file, args, { cwd, timeoutSeconds = 180 } = {}) {
  const { stdout } = await execute(file, args, {
    cwd,
    timeout: timeoutSeconds * 1000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
  });
  return stdout.trim();
}

export async function discover(root) {
  const plugins = path.join(root, 'plugins');
  const entries = await fs.readdir(plugins, { withFileTypes: true });
  const repos = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const cwd = path.join(plugins, entry.name);
    try {
      await fs.stat(path.join(cwd, '.git'));
      repos.push({ name: entry.name, cwd });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  repos.push({ name: 'TRSS-Yunzai', cwd: root });
  return repos;
}

export async function updateRepo(repo, options = {}) {
  const git = (...args) => command('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo.cwd, timeoutSeconds: options.timeoutSeconds,
  });
  const result = { name: repo.name, status: 'failed', changed: false, dependenciesChanged: false, commits: [] };
  try {
    const top = await fs.realpath(await git('rev-parse', '--show-toplevel'));
    const here = await fs.realpath(repo.cwd);
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(top) !== normalize(here)) throw new Error('目录不是独立 Git 仓库');
    result.before = await git('rev-parse', 'HEAD');
    if (await git('status', '--porcelain', '--untracked-files=no')) {
      return { ...result, status: 'skipped', detail: '存在本地修改，保留并跳过' };
    }
    if (!await git('branch', '--show-current')) {
      return { ...result, status: 'skipped', detail: '处于 detached HEAD，请先切换分支' };
    }
    try {
      await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
    } catch {
      return { ...result, status: 'skipped', detail: '未设置上游跟踪分支' };
    }
    await git('pull', '--ff-only');
    result.after = await git('rev-parse', 'HEAD');
    result.changed = result.before !== result.after;
    if (!result.changed) return { ...result, status: 'unchanged' };
    const files = await git('diff', '--name-only', result.before, result.after, '--');
    result.dependenciesChanged = files.split('\n').some(file => manifests.test(file));
    const limit = options.maxCommits ?? 5;
    result.count = Number(await git('rev-list', '--count', `${result.before}..${result.after}`));
    const log = await git('log', `-${limit}`, '--format=%h %s', `${result.before}..${result.after}`);
    result.commits = log.split('\n').filter(Boolean).map(line => line.slice(0, 200));
    return { ...result, status: 'updated' };
  } catch (error) {
    // pull 的输出或后续日志读取失败时，仍核实 HEAD，避免漏掉已经落盘的更新。
    if (result.before) {
      try {
        result.after = await git('rev-parse', 'HEAD');
        result.changed = result.before !== result.after;
        if (result.changed) result.dependenciesChanged = true;
      } catch { /* 原始错误保留在报告中。 */ }
    }
    return { ...result, detail: cleanError(error) };
  }
}

export async function updateAll(root, options = {}) {
  const results = [];
  for (const repo of await discover(root)) results.push(await updateRepo(repo, options));
  return results;
}

export function installDependencies(root, timeoutSeconds = 600) {
  if (process.platform === 'win32') {
    return command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm install --no-frozen-lockfile'], { cwd: root, timeoutSeconds });
  }
  return command('pnpm', ['install', '--no-frozen-lockfile'], { cwd: root, timeoutSeconds });
}
