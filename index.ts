// opencode-plugin-skill-evo — skill 自进化插件 (opencode v2)
// 把 Hermes 的「任务后自动沉淀/修订技能」机制移植为 opencode 插件：
//   session.idle → 拉取会话转录 → 独立配置的模型判定 → create/patch SKILL.md → skill.reload()
// 无外部依赖，纯 TS，Bun 直接运行。仅支持 opencode v2。

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const DEFAULTS = {
  enabled: true,
  model: "",              // "providerID/modelID"；留空 = 当前默认模型
  scope: "project",       // "project" | "global" | "both"（LLM 在允许范围内挑）
  minTurns: 4,            // 用户轮数低于此值不进化
  maxPerDay: 3,           // 每日 create/patch 上限
  transcriptChars: 24000, // 喂给判定模型的转录截断长度
  dryRun: false,          // 只分析报告，不落盘
  globalDir: "~/.agents/skills",
  debugLog: "",           // 调试日志路径，相对项目目录
}

type Decision = {
  decision: "skip" | "create" | "patch"
  id?: string
  name?: string
  description?: string
  scope?: "project" | "global"
  markdown?: string
  reason?: string
}

export default {
  id: "skill-evo",
  async setup(ctx: any) {
    const o = { ...DEFAULTS, ...(ctx.options ?? {}) }
    if (!o.enabled) return

    const projDir: string = ctx.location?.directory ?? process.cwd()
    const resolveP = (p: string) =>
      p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : path.resolve(projDir, p)
    const globalDir = resolveP(String(o.globalDir))
    const logPath = o.debugLog ? resolveP(String(o.debugLog)) : ""

    async function log(msg: string) {
      const line = `[skill-evo ${new Date().toISOString()}] ${msg}`
      console.log(line)
      if (logPath) {
        try {
          await mkdir(path.dirname(logPath), { recursive: true })
          await writeFile(logPath, line + "\n", { flag: "a" })
        } catch {}
      }
    }

    // ---- storage（ctx.storage 优先，失败退回内存）----
    const mem = new Map<string, unknown>()
    const store = {
      async get(k: string): Promise<any> {
        try { const v = await ctx.storage?.get(k); if (v !== undefined) return v } catch {}
        return mem.get(k)
      },
      async set(k: string, v: unknown) {
        mem.set(k, v)
        try { await ctx.storage?.set(k, v) } catch {}
      },
    }

    // ---- 独立模型调用 ----
    async function resolveModel(): Promise<{ providerID: string; id: string } | undefined> {
      if (o.model && String(o.model).includes("/")) {
        const [providerID, ...rest] = String(o.model).split("/")
        return { providerID, id: rest.join("/") }
      }
      for (let i = 0; i < 2; i++) {
        try {
          const d = await ctx.model?.default?.()
          if (d?.providerID && d?.id) return { providerID: d.providerID, id: d.id }
        } catch {}
        if (i === 0) await new Promise(r => setTimeout(r, 2000))
      }
      if (lastModel?.providerID && lastModel?.id) return lastModel
      try {
        const list = await ctx.model.list()
        log(`模型解析失败。list 共 ${list?.length ?? 0} 个，前 5 个: ${JSON.stringify((list ?? []).slice(0, 5).map((m: any) => ({ p: m.providerID, id: m.id })))}；default()=${JSON.stringify(await ctx.model.default?.())}`)
      } catch (e: any) { log(`模型解析失败且 list 也失败: ${e?.message ?? e}`) }
      return undefined
    }

    async function genText(model: any, prompt: string): Promise<string> {
      const api = ctx.experimental?.generate ?? ctx.generate
      if (!api?.text) throw new Error("generate API 不可用（需要 opencode v2.3+）")
      const call = async (m: any) => {
        const res = await api.text({ model: m, prompt })
        return typeof res === "string" ? res : (res?.text ?? "")
      }
      // 注册表查找对 对象/字符串 两种形式敏感，且 reload 后可能未就绪：依次尝试并退避重试
      let lastErr: any
      for (const m of [model, `${model.providerID}/${model.id}`]) {
        try { return await call(m) } catch (e: any) { lastErr = e }
      }
      await new Promise(r => setTimeout(r, 3000))
      try { return await call(model) } catch (e: any) { throw lastErr ?? e }
    }

    // ---- 转录采集 ----
    function flatten(messages: any[]): string {
      const parts: string[] = []
      for (const m of messages ?? []) {
        const role: string = m?.role ?? m?.info?.role ?? m?.type ?? m?.info?.type ?? "?"
        let text = ""
        for (const x of m?.parts ?? m?.info?.parts ?? []) {
          if (x?.type === "text") text += x.text ?? ""
          else if (x?.type === "tool") {
            const name = x.state?.name ?? x.name ?? x.tool ?? "tool"
            let out = ""
            try {
              const outs = x.state?.output ?? x.output ?? []
              for (const o of outs) out += (o?.content ?? o?.text ?? "") + " "
              out = out.trim().slice(0, 400)
            } catch {}
            text += `\n[tool:${name}] ${out}`.trimEnd()
          }
        }
        if (!text && typeof m?.text === "string") text = m.text
        if (text.trim()) parts.push(`${String(role).toUpperCase()}: ${text.trim()}`)
      }
      return parts.join("\n\n")
    }

    function truncate(s: string, max: number): string {
      if (s.length <= max) return s
      const head = Math.floor(max * 0.65)
      return s.slice(0, head) + `\n\n...[中间省略 ${s.length - max} 字符]...\n\n` + s.slice(s.length - (max - head))
    }

    // ---- 技能清单（读盘）----
    async function scanSkills(dir: string) {
      const out: { id: string; description: string; file: string }[] = []
      try {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue
          const f = path.join(dir, e.name, "SKILL.md")
          if (!existsSync(f)) continue
          const txt = await readFile(f, "utf8")
          const desc = (/^description:\s*(.+)$/m.exec(txt)?.[1] ?? "").trim().slice(0, 120)
          out.push({ id: e.name, description: desc, file: f })
        }
      } catch {}
      return out
    }

    // ---- 判定 prompt ----
    function judgePrompt(transcript: string, inventory: string, allowed: string[]): string {
      return `你是「技能进化引擎」。给你一段 coding agent 会话转录和现有技能清单，判断其中是否包含值得沉淀的、可复用的程序性经验（流程/规则/坑），并决定：
1. skip —— 没有可复用经验（一次性任务、纯问答、无坑无流程）
2. create —— 新建技能
3. patch —— 修订现有技能（当会话暴露了现有技能缺失的步骤/坑时）

只输出一个 JSON 对象（markdown 字符串内换行用 \\n 转义），不要其它文字：
{"decision":"skip|create|patch","id":"kebab-case 小写连字符","name":"显示名","description":"Use when <触发条件>. <行为>.","scope":"project 或 global","markdown":"SKILL.md 正文（不含 frontmatter，skip 时省略）","reason":"一句话理由"}

写作规范（必须遵守，源自 Hermes 技能规范）：
- 写教训不写流水账：只沉淀可泛化的流程/规则/坑；禁止叙事、禁止一次性细节（PR 号、日期、临时路径）
- 特别注意：会话中暴露的系统/工具/环境坑（如某命令在某 OS 版本上的行为差异、报错与绕行方案）是最有价值的技能素材，[tool:...] 输出里的报错就是证据
- 一条规则一个教训：祈使句 + 一句原因；没有原因的规则不写
- description 必须是 "Use when <触发条件>. <行为>." 格式，中文 ≤40 字或英文 ≤60 字符
- id 小写 kebab-case，1-64 字符；patch 时 id 必须取自现有清单
- scope 只能取 [${allowed.join(", ")}]；项目专属的选 project，跨项目通用的选 global（若允许）
- markdown ≤80 行，结构：# 标题 / 适用条件 / 步骤 / 已知坑

现有技能清单：
${inventory || "（无）"}

会话转录：
${transcript}`
    }

    function parseDecision(raw: string): Decision | null {
      const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
      for (const cand of [fenced?.[1], raw]) {
        if (!cand) continue
        const tryJson = (s: string): Decision | null => {
          try { const j = JSON.parse(s); return j?.decision ? j : null } catch { return null }
        }
        const direct = tryJson(cand)
        if (direct) return direct
        const a = cand.indexOf("{"), b = cand.lastIndexOf("}")
        if (a >= 0 && b > a) { const j = tryJson(cand.slice(a, b + 1)); if (j) return j }
      }
      return null
    }

    // ---- 主流程 ----
    async function evolve(sessionID: string, force = false) {
      const claimKey = `evolved:${sessionID}`
      if (!force && await store.get(claimKey)) return
      await store.set(claimKey, true) // 先占位防重入

      let info: any
      try { info = await ctx.session?.get?.({ sessionID }) } catch {}
      if (info?.parentID || info?.parent_id) return // 子代理会话不进化

      let messages: any
      try {
        // messages() 含 tool parts（shell 输出等证据）；退回 context() 只有文本摘要
        messages = await ctx.session?.messages?.({ sessionID }) ?? await ctx.session?.context?.({ sessionID })
      } catch (e: any) {
        try { messages = await ctx.session?.context?.({ sessionID }) } catch (e2: any) {
          return log(`session.messages/context 均失败 ${sessionID}: ${e?.message ?? e} / ${e2?.message ?? e2}`)
        }
      }
      const arr = Array.isArray(messages) ? messages : messages?.messages ?? []
      const ev = evidence.get(sessionID) ?? []
      const transcript = flatten(arr) + (ev.length ? `\n\n[工具执行证据]\n${ev.join("\n")}` : "")
      const userTurns = (transcript.match(/^USER:/gm) ?? []).length
      if (userTurns < o.minTurns) {
        log(`跳过 ${sessionID}: 用户轮数 ${userTurns} < ${o.minTurns}（转录 ${transcript.length} 字符，消息 ${arr.length} 条，证据 ${ev.length} 条）`)
        if (arr.length) {
          const first = arr[0]
          log(`msg[0] keys=[${Object.keys(first ?? {}).join(",")}] preview=${JSON.stringify(first).slice(0, 600)}`)
        } else {
          log(`context 返回类型=${typeof messages} 预览=${JSON.stringify(messages).slice(0, 400)}`)
        }
        return
      }

      const day = new Date().toISOString().slice(0, 10)
      const used = Number((await store.get(`count:${day}`)) ?? 0)
      if (used >= o.maxPerDay) return log(`跳过 ${sessionID}: 今日已达上限 ${o.maxPerDay}`)

      const model = await resolveModel()
      if (!model) return log(`跳过 ${sessionID}: 无法解析进化模型（options.model 或默认模型）`)

      const allowed = o.scope === "both" ? ["project", "global"] : [String(o.scope)]
      const projSkills = allowed.includes("project") ? await scanSkills(path.join(projDir, ".opencode", "skills")) : []
      const globSkills = allowed.includes("global") ? await scanSkills(globalDir) : []
      const inventory = [...projSkills, ...globSkills]
        .map(s => `- ${s.id}: ${s.description}`).join("\n")

      log(`进化 ${sessionID}: turns=${userTurns} model=${model.providerID}/${model.id} 现有技能=${projSkills.length + globSkills.length}`)
      let raw: string
      try {
        raw = await genText(model, judgePrompt(truncate(transcript, o.transcriptChars), inventory, allowed))
      } catch (e: any) {
        try {
          const list = await ctx.model.list()
          return log(`generate 失败 ${sessionID}: ${e?.message ?? e}；注册表前 8: ${JSON.stringify((list ?? []).slice(0, 8).map((m: any) => ({ p: m.providerID, id: m.id })))}`)
        } catch { return log(`generate 失败 ${sessionID}: ${e?.message ?? e}`) }
      }
      const d = parseDecision(raw)
      if (!d) return log(`判定解析失败 ${sessionID}: ${raw.slice(0, 300)}`)
      if (d.decision === "skip") return log(`判定=skip: ${d.reason ?? ""}`)

      // 目标解析
      let id = String(d.id ?? "")
      if (!ID_RE.test(id) || id.length > 64) return log(`非法 id "${id}"，放弃`)
      const existing = inventory.length
        ? [...projSkills, ...globSkills].find(s => s.id === id)
        : undefined
      if (d.decision === "patch" && !existing) return log(`patch 目标 ${id} 不存在，放弃`)
      if (d.decision === "create" && existing) d.decision = "patch" // 防重复：降级为修订

      let scope = (d.scope && allowed.includes(d.scope)) ? d.scope : allowed[0]
      if (existing) scope = existing.file.startsWith(globalDir) ? "global" : "project"
      const dir = scope === "global"
        ? path.join(globalDir, id)
        : path.join(projDir, ".opencode", "skills", id)
      const file = existing?.file ?? path.join(dir, "SKILL.md")

      const description = String(d.description ?? "").trim() || `Use when ${id} 相关任务.`
      const body = String(d.markdown ?? "").trim()
      if (!body) return log(`markdown 为空，放弃`)
      const content = `---\nname: ${String(d.name ?? id)}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body}\n`

      if (o.dryRun) {
        return log(`[dryRun] decision=${d.decision} scope=${scope} id=${id}\n---\n${content.slice(0, 1200)}\n---`)
      }
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content, "utf8")
      try { await ctx.skill?.reload?.() } catch {}
      await store.set(`count:${day}`, used + 1)
      log(`✔ ${d.decision} ${scope} 技能 → ${file}\n理由: ${d.reason ?? ""}\n描述: ${description}`)
    }

    // ---- 手动/调试：forceEvolve 指定会话立即进化 ----
    if (o.forceEvolve) {
      void evolve(String(o.forceEvolve), true).catch((e: any) => log(`forceEvolve 异常: ${e?.message ?? e}`))
    }

    // ---- 订阅事件：execution 结束后防抖进化（成功/失败都进化）----
    const controller = new AbortController()
    if (!ctx.event?.subscribe) {
      log("ctx.event.subscribe 不可用，插件空转（需要 opencode v2）")
      return
    }
    const seenTypes = new Map<string, number>()
    const pending = new Map<string, any>()
    let lastModel: any = undefined
    // live 证据缓冲：工具输出/命令不落在 messages API 里，从事件流采集
    const evidence = new Map<string, string[]>()
    const shells = new Map<string, string>()
    const shellSession = new Map<string, string>()
    const pushEv = (sid: string, line: string) => {
      if (!sid || !line) return
      const arr = evidence.get(sid) ?? []
      if (arr.length < 200) arr.push(line.slice(0, 500))
      evidence.set(sid, arr)
    }
    const cancelEvolve = (sid: string) => {
      const t = pending.get(sid)
      if (t) { clearTimeout(t); pending.delete(sid) }
    }
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal }) as any) {
          const type = String((ev as any)?.type ?? "?")
          const props = (ev as any)?.properties ?? (ev as any)?.data ?? {}
          const n = (seenTypes.get(type) ?? 0) + 1
          seenTypes.set(type, n)
          if (n <= 2) log(`EVT ${type} ${JSON.stringify(props).slice(0, 160)}`)
          if (type === "session.step.started" && props.model?.providerID) {
            lastModel = { providerID: props.model.providerID, id: props.model.id }
          }
          // 证据采集（shell 事件不带 sessionID，经 tool.progress 的 shellID 关联）
          const sid0: string | undefined = props.sessionID
          if (sid0) {
            if (type === "session.tool.progress" && props.metadata?.shellID) {
              shellSession.set(String(props.metadata.shellID), sid0)
            }
            if (type === "session.tool.success") {
              const texts = (props.content ?? []).map((c: any) => c?.text ?? c?.content ?? "").join(" ")
              pushEv(sid0, `[tool-result] ${String(texts).slice(0, 500)}`)
            }
          }
          if (type === "shell.created" && props.info?.id) {
            shells.set(String(props.info.id), String(props.info.command ?? ""))
          } else if (type === "shell.exited") {
            const s = shellSession.get(String(props.id))
            const cmd = shells.get(String(props.id))
            if (s && cmd !== undefined) pushEv(s, `[shell exit=${props.exit}] ${cmd}`.slice(0, 500))
            shells.delete(String(props.id))
            shellSession.delete(String(props.id))
          }
          const sid: string | undefined = props.sessionID ?? (ev as any).sessionID
          if (!sid) continue
          if (type === "session.execution.started") { cancelEvolve(sid); continue }
          if (type === "session.execution.succeeded" || type === "session.execution.failed") {
            cancelEvolve(sid)
            const t = setTimeout(() => {
              pending.delete(sid)
              evolve(sid).catch(async (e: any) => log(`evolve 异常 ${sid}: ${e?.message ?? e}`))
            }, Number(o.idleDelayMs ?? 45_000))
            pending.set(sid, t)
          }
        }
        log("事件流结束")
      } catch (e: any) {
        if (e?.name !== "AbortError") log(`事件流异常: ${e?.message ?? e}`)
      }
    })()

    log(`已加载 v0.2.0 proj=${projDir} scope=${o.scope} model=${o.model || "(默认)"} dryRun=${o.dryRun} idleDelayMs=${o.idleDelayMs ?? 45_000}`)
    return () => {
      log("卸载")
      for (const t of pending.values()) clearTimeout(t)
      controller.abort()
    }
  },
}
