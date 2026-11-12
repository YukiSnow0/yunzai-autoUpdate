# yunzai-autoUpdate

给 **TRSS-Yunzai** 用的轻量每日更新插件：更新本体及 `plugins/` 下全部 Git 插件，把更新结果私聊发送给主人 QQ。

默认每天 **北京时间 04:00** 执行。有代码更新时，依赖安装成功后调用 TRSS 的完整重启接口，机器人重新上线后推送报告。没有更新也会发送检查结果。

只有这一项功能。复用 TRSS 已有的 `node-schedule`，其他逻辑仅使用 Node.js 标准库；无需新增 Redis 键、数据库、面板或额外依赖。

## 环境

- Node.js 24+、Git、pnpm。
- 支持 `Bot.restart()`、`plugin.addCleanup()` 和多机器人接口的近期 TRSS-Yunzai。
- Linux / Windows。Windows 的依赖安装通过固定的 `cmd.exe` 命令调用 pnpm。
- 机器人已登录，主人 QQ 能接收机器人私聊消息，通常应先加好友。

本项目按插件形式开发，不修改机器人配置，也不会在开发或测试时自动安装到机器人环境。

## 手动安装

需要使用时，在 **TRSS-Yunzai 根目录**执行：

```bash
git clone https://github.com/YukiSnow0/yunzai-autoUpdate.git plugins/yunzai-autoUpdate
```

然后完整重启 TRSS。已有 `node-schedule` 的正常 TRSS 环境无需为本插件额外安装依赖。

请先关闭 TRSS 自带的 `update_time` / `update_cron` 自动更新任务，以及其他插件的自动更新功能，避免同时执行 Git 操作。插件不自动修改这些设置。

## 配置

首次加载会生成：

```text
data/yunzai-autoUpdate/config.json
```

配置和最后一次报告放在 TRSS 的 `data/` 中，更新本插件不会覆盖。修改配置后完整重启 TRSS。

```json
{
  "enabled": true,
  "cron": "0 0 4 * * *",
  "timezone": "Asia/Shanghai",
  "autoRestart": true,
  "masters": [],
  "botId": "",
  "timeoutSeconds": 180,
  "installTimeoutSeconds": 600,
  "maxCommits": 5
}
```

| 配置项 | 作用 |
| --- | --- |
| `enabled` | 是否创建每日更新任务。关闭后仍会尝试补发已有的待推送报告。 |
| `cron` | 六段 Cron：秒、分、时、日、月、星期。默认 `0 0 4 * * *`。同一个配置时区的日期最多执行一次，不补跑已错过的时刻。 |
| `timezone` | 定时任务和报告的时区，默认北京时间，不依赖操作系统时区。 |
| `autoRestart` | 有更新时完整重启 TRSS。关闭时立即推送报告，并提示手动重启。 |
| `masters` | 留空读取 TRSS 的 `cfg.masterQQ` 和各机器人 `cfg.master`。可填 QQ 字符串数组覆盖，例如 `["100000001"]`。忽略 `stdin` 等非 QQ 标识。 |
| `botId` | 留空自动选择在线 QQ 机器人，优先使用该主人的关联机器人；同一个主人只推送一份。填写后仅使用指定机器人。 |
| `timeoutSeconds` | 每条 Git 命令的超时秒数，默认 180。 |
| `installTimeoutSeconds` | pnpm 安装超时秒数，默认 600。 |
| `maxCommits` | 每个仓库最多展示几条提交，默认 5，最大 50。 |

## 更新与推送行为

- 按顺序更新各 Git 插件，最后更新 TRSS 本体；当前插件也会更新自身。
- 使用仓库当前分支配置的上游执行 `git pull --ff-only`，不强制重置、不自动合并分叉，不丢弃本地修改。
- 已修改跟踪文件、没有上游、处于 detached HEAD 时跳过并在报告中说明。单个插件失败不阻止其他仓库更新。
- 支持插件 `.git` 目录和 worktree 的 `.git` 文件；普通文件夹、单文件 JS 插件和目录符号链接不执行 Git 更新。
- 本体或插件的 `package.json`、pnpm 锁文件或工作区配置有变化时，在 TRSS 根目录执行一次 `pnpm install --no-frozen-lockfile`。适用于 TRSS 的 `plugins/**` pnpm 工作区；需要独立构建步骤的插件仍需自行处理。
- 安装失败会保留重试标记并暂缓重启，下次每日任务继续尝试。代码已经拉取，未完成依赖安装前应避免使用受影响的新功能。
- 自动重启前先保存报告；完整重启后，机器人上线时私聊主人，报告包含各仓库状态、提交摘要、依赖与重启结果。
- 多机器人时按主人 QQ 去重。每段 QQ 消息最多等待 30 秒；发送失败会尝试其他在线 QQ 机器人，指定 `botId` 时不切换。离线时保留报告，后续机器人连接时补发；不会借用群聊推送。
- 只保留最近一次报告和待发送主人列表，防止日志无限增长。崩溃或分段发送中途失败后可能重发部分内容，成功投递后不再重复发送。连续多日离线时仅保留最近一次结果。

没有手动更新口令、通配消息监听或网页面板。需要排查时看控制台的 `[yunzai-autoUpdate]` 日志以及 `data/yunzai-autoUpdate/state.json`。

## 开发与验证

```bash
npm test
npm run check
```

测试使用本机临时 Git 仓库和模拟机器人出口，不连接生产 QQ，也不更新真实 TRSS。GitHub Actions 在 Linux / Windows、Node.js 24 上执行验证。

更新行为参考 [Nwflower/auto-plugin 的 autoUpdate 功能](https://github.com/Nwflower/auto-plugin)。本项目为独立实现，MIT 许可证。
