import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanError } from './updater.js';
import { formatReport, splitMessage } from './report.js';

export async function readState(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { lastRunDay: '', needsInstall: false, needsRestart: false, report: null, pendingOwners: [] };
  }
}

export class UpdateService {
  constructor({ file, state, config, bootId, update, install, targets, send, restart, log, now = () => new Date(), sendTimeoutMs = 30000 }) {
    Object.assign(this, { file, state, config, bootId, update, install, targets, send, restart, log, now, sendTimeoutMs });
    this.writes = Promise.resolve();
  }

  save() {
    const json = JSON.stringify(this.state, null, 2);
    const write = async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, json, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  async resume() {
    if (this.state.needsRestart && !this.state.needsInstall && this.state.updateBoot !== this.bootId) {
      this.state.needsRestart = false;
      if (this.state.report) this.state.report.restart = 'TRSS 已完整重启，更新已应用';
      await this.save();
    }
    await this.flush();
  }

  run() {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async runOnce() {
    const date = this.now();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timezone }).format(date);
    if (this.state.lastRunDay === day) return false;
    this.state.lastRunDay = day;
    await this.save();
    let results;
    try { results = await this.update(); }
    catch (error) { results = [{ name: '更新任务', status: 'failed', changed: false, commits: [], detail: cleanError(error) }]; }
    if (results.some(item => item.changed)) {
      this.state.needsRestart = true;
      this.state.updateBoot = this.bootId;
    }
    if (results.some(item => item.dependenciesChanged)) this.state.needsInstall = true;
    await this.save();
    let dependencies = '';
    if (this.state.needsInstall) {
      try {
        await this.install();
        this.state.needsInstall = false;
        dependencies = 'pnpm install 成功';
      } catch (error) { dependencies = `安装失败，已暂缓重启，下次任务重试：${cleanError(error)}`; }
    }
    const shouldRestart = this.state.needsRestart && !this.state.needsInstall && this.config.autoRestart;
    if (this.state.needsRestart) this.state.updateBoot = this.bootId;
    this.state.report = {
      time: date.toISOString(), results, dependencies,
      restart: shouldRestart ? '等待 TRSS 完整重启' : this.state.needsRestart ? '存在未应用的代码更新，需要完整重启 TRSS' : '无需重启',
    };
    const owners = this.targets().map(target => target.qq);
    this.state.pendingOwners = owners.length ? owners : null;
    await this.save();
    if (shouldRestart) {
      try {
        if (await this.restart() === false) throw new Error('TRSS 拒绝重启');
      }
      catch (error) {
        this.state.report.restart = `自动重启失败，请手动重启：${cleanError(error)}`;
        await this.save();
        await this.flush();
      }
    } else await this.flush();
    return this.state.report;
  }

  flush() {
    if (this.flushing) return this.flushing.then(() => this.flush());
    this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async flushOnce() {
    const report = this.state.report;
    if (!report || (report.restart === '等待 TRSS 完整重启' && this.state.updateBoot === this.bootId)) return;
    const targets = this.targets();
    if (this.state.pendingOwners === null) {
      if (!targets.length) return;
      this.state.pendingOwners = targets.map(target => target.qq);
      await this.save();
    }
    const text = formatReport(report, this.config.timezone);
    for (const qq of [...this.state.pendingOwners]) {
      if (this.state.report !== report) return;
      const target = targets.find(item => item.qq === qq);
      for (const botId of target?.botIds || []) {
        try {
          for (const part of splitMessage(text)) {
            let timer;
            let result;
            try {
              result = await Promise.race([
                Promise.resolve().then(() => this.send(botId, qq, part)),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('QQ 消息发送超过 30 秒，保留报告待补发')), this.sendTimeoutMs); }),
              ]);
            } finally { clearTimeout(timer); }
            if (!result || result.error || result.status === 'failed' || (result.retcode !== undefined && result.retcode !== 0)) {
              throw new Error('QQ 消息发送失败');
            }
          }
          if (this.state.report !== report) return;
          this.state.pendingOwners = this.state.pendingOwners.filter(item => item !== qq);
          await this.save();
          break;
        } catch (error) { this.log(`推送 ${qq} 失败：${cleanError(error)}`); }
      }
    }
  }
}
