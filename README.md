# opencode-plugin-skill-evo

> Self-evolving skills for [OpenCode](https://opencode.ai) v2 — after each session, a **separately configured model** mines the transcript for reusable lessons and auto-writes/patches `SKILL.md` files, project-wide or globally.

把 Hermes Agent 的「任务后自动沉淀/修订技能」机制移植到 opencode v2 的插件。

会话执行结束 → 采集转录+工具证据 → **独立配置的模型**判定是否有可复用经验 → 自动 create/patch `SKILL.md`（项目或全局）→ `skill.reload()` 热生效。

要求：opencode v2.3+（`opencode serve` 常驻服务）。

## 安装

```bash
git clone https://github.com/<you>/opencode-plugin-skill-evo.git ~/projects/opencode-plugin-skill-evo
```

在你的项目里启用（项目级，不影响全局配置）：

```jsonc
// <project>/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "~/projects/opencode-plugin-skill-evo",
      "options": {
        "model": "anthropic/claude-sonnet-4",   // 进化专用模型（任何 opencode 已配置的 provider/model 均可），独立于会话模型，可挑便宜的
        "scope": "project",                     // "project" | "global" | "both"（由判定模型按通用性挑层级）
        "minTurns": 2,
        "idleDelayMs": 45000,
        "debugLog": ".skill-evo-debug.log"
      }
    }
  ]
}
```

## 配置项

| 选项 | 默认 | 说明 |
|---|---|---|
| `model` | ""（默认模型） | 进化判定专用模型，`providerID/modelID` 字符串；与主会话模型解耦，可用便宜模型 |
| `scope` | `project` | 自进化范围：`project`→`.opencode/skills/`，`global`→`~/.agents/skills/`（可配 `globalDir`），`both`→由判定模型按通用性挑 |
| `minTurns` | 4 | 用户轮数门槛，过滤琐碎会话 |
| `maxPerDay` | 3 | 每日 create/patch 上限，防技能库膨胀 |
| `idleDelayMs` | 45000 | execution 结束后的防抖：交互会话连续追问只在静默后进化一次 |
| `dryRun` | false | 只报告不落盘 |
| `forceEvolve` | "" | 填 sessionID，插件加载时对该会话立即进化（手动补跑） |
| `globalDir` | `~/.agents/skills` | 全局技能目录 |
| `transcriptChars` | 24000 | 喂给判定模型的转录截断长度 |
| `debugLog` | "" | 调试日志路径（相对项目目录） |

## 移植自 Hermes 的防护

- 写前查重：create 遇到已有同 ID 技能自动降级为 patch
- 判定 prompt 内嵌 Hermes 技能写作规范（教训非流水账、一条规则一个教训、`Use when` 触发式 description、kebab-case id、≤80 行）
- 防回环：子代理会话跳过；每会话只进化一次（storage 去重）
- 每日上限 + 最小轮数门槛

## 已实测（2026-11-19, opencode 2.3.2）

`opencode run`（png→webp 任务）→ 自动沉淀 `.opencode/skills/macos-webp-conversion/SKILL.md`，
提取出 4 条带证据的环境坑（sips --formats 声明与实现不一致等），服务器 `skill.updated` 热重载成功。

## 本版 opencode (2.3.x) 的 API 事实（调试踩坑记录）

- 事件流**没有** `session.idle`；完成信号是 `session.execution.succeeded/failed`，模型信息在 `session.step.started`
- `generate.text` 的 `model` 参数要 **字符串** `"providerID/modelID"`；对象形式报 `Expected Model.Ref`
- `session.context` 返回 `{id,time,text,files,type}`（`type` 是 user/assistant，不是 `role`），且**不含工具输出**——shell 命令/结果需从事件流采集（`session.tool.success` 的 content；shell 经 `session.tool.progress` 的 `metadata.shellID` 关联）
- `opencode models` 列的是 models.dev 公共目录，不是本机 provider；看本机用 `jq` 读 `opencode.json`
- `opencode run` 走常驻服务 `opencode serve --service`，防抖定时器在服务内可靠触发

## 路线图

- [ ] TUI/desktop 通知进化结果（`tui.toast.show`）
- [ ] patch 前后 diff 审计日志 + git 提交
- [ ] 按项目配置 `excludeDirs` / 技能白名单
- [ ] 判定模型的 few-shot 示例（提高 skip/create 边界稳定性）
