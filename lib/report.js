export function formatReport(report, timezone) {
  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, dateStyle: 'short', timeStyle: 'short', hour12: false,
  }).format(new Date(report.time));
  const counts = status => report.results.filter(item => item.status === status).length;
  const lines = [
    `【自动更新】${time}`,
    `更新 ${counts('updated')} · 最新 ${counts('unchanged')} · 跳过 ${counts('skipped')} · 失败 ${counts('failed')}`,
  ];
  const labels = { updated: '已更新', unchanged: '已是最新', skipped: '跳过', failed: '失败' };
  for (const item of report.results) {
    lines.push(`\n${item.name}：${labels[item.status]}`);
    if (item.changed) lines.push(`${item.before.slice(0, 7)} → ${item.after.slice(0, 7)}`);
    if (item.detail) lines.push(item.detail);
    for (const commit of item.commits) lines.push(`  ${commit}`);
    if (item.count > item.commits.length) lines.push(`  共 ${item.count} 条提交，仅展示前 ${item.commits.length} 条`);
  }
  if (report.dependencies) lines.push(`\n依赖：${report.dependencies}`);
  lines.push(`\n${report.restart}`);
  return lines.join('\n');
}

export function splitMessage(text, limit = 2800) {
  const chars = Array.from(text);
  const parts = [];
  for (let i = 0; i < chars.length; i += limit) parts.push(chars.slice(i, i + limit).join(''));
  return parts;
}

export function resolveTargets(hostConfig, config, bot) {
  const numeric = value => /^\d{5,12}$/.test(String(value));
  const mapping = hostConfig.master || {};
  const owners = config.masters.length ? config.masters : [
    ...(hostConfig.masterQQ || []), ...Object.values(mapping).flat(),
  ];
  const online = [...new Set(Array.from(bot.uin || [], String))].filter(numeric);
  return [...new Set(owners.map(String).filter(numeric))].map(qq => {
    const preferred = Object.entries(mapping)
      .filter(([, ids]) => ids.map(String).includes(qq)).map(([id]) => id);
    const candidates = config.botId ? [String(config.botId)] : [...preferred, ...online];
    return { qq, botIds: [...new Set(candidates)].filter(id => online.includes(id)) };
  });
}
