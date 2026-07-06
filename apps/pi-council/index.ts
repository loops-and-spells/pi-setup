/**
 * pi-council — mix-of-models orchestration inside pi, with runtime role picking.
 *
 * Any OpenAI-compatible model registered in pi can play a role:
 *   - advisors: brief the chairman (pi's current model) before each user turn,
 *     each through a lens (scout | skeptic | architect)
 *   - checker: audits the final answer against the request; violations trigger
 *     one revision turn (budgeted per user input, so it can never loop)
 *
 * Roles come from the benchmarked council pipeline in pi-setup/apps/pi-bench
 * (ornith-council, 284/300). The chairman is whatever model pi is on, so this
 * composes with every engine: vllm chairman + scout checker, etc.
 *
 * Commands:
 *   /council                       status
 *   /council on | off
 *   /council advisors <m[:lens],…> set advisors ("off" clears)
 *   /council checker <m> | off     set or clear the checker
 *   /council revisions <n>         max revision turns per user input
 *   /council models                list eligible models with endpoint health
 *   /council pick                  interactive role picker
 *
 * Installed via symlink from ~/.pi/agent/extensions/pi-council.ts; the source
 * of truth lives in pi-setup/apps/pi-council/index.ts.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext
} from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = path.join(os.homedir(), ".pi/agent/council.json")
const SCOUT_UNIT = "council-scout.service"
const SCOUT_PORT = 9107

const LENSES: Record<string, string> = {
  scout:
    "You are the council's Scout, a small fast model briefing a much stronger one. " +
    "Produce: (1) a checklist of every explicit requirement and constraint in the request, " +
    "quoted exactly; (2) the three hardest parts and why; (3) a terse plan of attack. " +
    "Do NOT write the answer itself.",
  skeptic:
    "You are the council's Skeptic. Attack the request before solving it: list the ways a " +
    "solution could be wrong, the edge cases and failure modes that matter most, and the " +
    "hardest test it must survive. Then sketch (do not fully write) the answer you would " +
    "accept. Be concrete and terse; your notes brief a stronger model that writes the final answer.",
  architect:
    "You are the council's Architect. Propose the strongest overall structure for the " +
    "answer: the approach you would take, the key design decisions with one-line rationale, " +
    "and the trickiest details worth getting exactly right (spell those out fully). Be " +
    "concrete and terse; your notes brief a stronger model that writes the final answer."
}

const CHECKER_SYSTEM =
  "You are a constraint compliance checker. First list every EXPLICIT constraint in the " +
  "request (word counts, required titles or sections, exact output formats, things the answer " +
  "must or must not contain). Then check the draft against each one. If every constraint " +
  "is met, reply with exactly PASS. Otherwise reply with a numbered list of the violated " +
  "constraints only — quote the requirement and state what the draft got wrong. Judge only " +
  "explicit constraints, not quality."

const REQUEST_CLIP = 20000
const BRIEF_CLIP = 12000
const DRAFT_CLIP = 36000
const BRIEF_TIMEOUT_MS = 3 * 60 * 1000
const CHECK_TIMEOUT_MS = 3 * 60 * 1000

interface AdvisorRef {
  model: string
  lens: string
}

interface CouncilConfig {
  enabled: boolean
  advisors: AdvisorRef[]
  checker: string | null
  maxRevisions: number
}

const defaultConfig = (): CouncilConfig => ({
  enabled: false,
  advisors: [{ model: "council-qwen3-4b/qwen3-4b", lens: "scout" }],
  checker: "council-qwen3-4b/qwen3-4b",
  maxRevisions: 1
})

const loadConfig = (): CouncilConfig => {
  try {
    return { ...defaultConfig(), ...(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as object) }
  } catch {
    return defaultConfig()
  }
}

const saveConfig = (cfg: CouncilConfig): void => {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// model plumbing
// ---------------------------------------------------------------------------

interface EligibleModel {
  ref: string
  baseUrl: string
  id: string
  maxTokens: number
}

/** Every registered model this extension can call directly. */
const eligibleModels = (ctx: ExtensionContext): EligibleModel[] =>
  (ctx.modelRegistry.getAll() as Array<Record<string, unknown>>)
    .filter((m) => m["api"] === "openai-completions" && typeof m["baseUrl"] === "string")
    .map((m) => ({
      ref: `${String(m["provider"])}/${String(m["id"])}`,
      baseUrl: (m["baseUrl"] as string).replace(/\/$/, ""),
      id: String(m["id"]),
      maxTokens: typeof m["maxTokens"] === "number" ? m["maxTokens"] : 4096
    }))

const resolveModel = (ctx: ExtensionContext, ref: string): EligibleModel | undefined => {
  const all = eligibleModels(ctx)
  return all.find((m) => m.ref === ref) ?? all.find((m) => m.id === ref)
}

const isHealthy = async (baseUrl: string): Promise<boolean> => {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

const stripThink = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim()

const memberChat = async (
  m: EligibleModel,
  messages: Array<{ role: string; content: string }>,
  opts: { temperature: number; maxTokens: number; timeoutMs: number }
): Promise<string> => {
  const res = await fetch(`${m.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: m.id,
      messages,
      temperature: opts.temperature,
      max_tokens: Math.min(opts.maxTokens, m.maxTokens),
      stream: false
    }),
    signal: AbortSignal.timeout(opts.timeoutMs)
  })
  if (!res.ok) throw new Error(`${m.ref} responded ${res.status}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return stripThink(data.choices?.[0]?.message?.content ?? "")
}

// ---------------------------------------------------------------------------
// message text extraction (defensive: AgentMessage shapes vary by role)
// ---------------------------------------------------------------------------

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as Record<string, unknown>
        return part["type"] === "text" && typeof part["text"] === "string" ? part["text"] : ""
      })
      .filter((t) => t !== "")
      .join("\n")
  }
  return ""
}

const lastText = (messages: unknown[], role: string): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>
    if (m?.["role"] === role) {
      const text = textOf(m["content"])
      if (text.trim() !== "") return text
    }
  }
  return ""
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  let cfg = loadConfig()
  // revision turns are budgeted per real user input so check→revise cannot loop
  let revisionBudget = 0
  let revising = false

  const scoutAutostart = async (ctx: ExtensionContext): Promise<void> => {
    const scoutRefs = [...cfg.advisors.map((a) => a.model), ...(cfg.checker !== null ? [cfg.checker] : [])]
    const usesScout = scoutRefs.some((r) => resolveModel(ctx, r)?.baseUrl.includes(`:${SCOUT_PORT}`))
    if (!usesScout || (await isHealthy(`http://127.0.0.1:${SCOUT_PORT}/v1`))) return
    ctx.ui.notify(`council: starting ${SCOUT_UNIT}…`, "info")
    try {
      await pi.exec("systemctl", ["--user", "start", SCOUT_UNIT])
      for (let i = 0; i < 60; i++) {
        if (await isHealthy(`http://127.0.0.1:${SCOUT_PORT}/v1`)) {
          ctx.ui.notify("council: scout ready on :9107", "info")
          return
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      ctx.ui.notify("council: scout did not become healthy in 120s", "warning")
    } catch (e) {
      ctx.ui.notify(`council: could not start scout: ${e instanceof Error ? e.message : e}`, "warning")
    }
  }

  const statusText = async (ctx: ExtensionContext): Promise<string> => {
    const lines: string[] = [`council: ${cfg.enabled ? "ON" : "off"} (chairman = current model)`]
    for (const a of cfg.advisors) {
      const m = resolveModel(ctx, a.model)
      const health = m === undefined ? "unknown model" : (await isHealthy(m.baseUrl)) ? "up" : "DOWN"
      lines.push(`  advisor: ${a.model} [${a.lens}] — ${health}`)
    }
    if (cfg.advisors.length === 0) lines.push("  advisor: none")
    if (cfg.checker !== null) {
      const m = resolveModel(ctx, cfg.checker)
      const health = m === undefined ? "unknown model" : (await isHealthy(m.baseUrl)) ? "up" : "DOWN"
      lines.push(`  checker: ${cfg.checker} — ${health} (max ${cfg.maxRevisions} revision/input)`)
    } else {
      lines.push("  checker: none")
    }
    return lines.join("\n")
  }

  // ------------------------------------------------------------------ briefs

  pi.on("input", () => {
    revisionBudget = cfg.maxRevisions
  })

  pi.on("before_agent_start", async (event, ctx) => {
    if (!cfg.enabled || cfg.advisors.length === 0 || revising) return
    const prompt = event.prompt.slice(0, REQUEST_CLIP)
    if (prompt.trim() === "") return
    ctx.ui.setWorkingMessage(`council: collecting ${cfg.advisors.length} brief(s)…`)
    const briefs = await Promise.all(
      cfg.advisors.map(async (a) => {
        const m = resolveModel(ctx, a.model)
        if (m === undefined) return null
        try {
          const text = await memberChat(
            m,
            [
              { role: "system", content: LENSES[a.lens] ?? LENSES["scout"] ?? "" },
              { role: "user", content: prompt }
            ],
            { temperature: 0.7, maxTokens: 4096, timeoutMs: BRIEF_TIMEOUT_MS }
          )
          return text === "" ? null : { ref: a.model, lens: a.lens, text: text.slice(0, BRIEF_CLIP) }
        } catch {
          return null
        }
      })
    )
    ctx.ui.setWorkingMessage()
    const good = briefs.filter((b): b is { ref: string; lens: string; text: string } => b !== null)
    if (good.length === 0) {
      if (cfg.advisors.length > 0) ctx.ui.notify("council: no advisor reachable, plain turn", "warning")
      return
    }
    ctx.ui.notify(`council: ${good.length}/${cfg.advisors.length} brief(s) collected`, "info")
    const body = good
      .map((b, i) => `### Advisor ${i + 1} (${b.ref}, ${b.lens})\n${b.text}`)
      .join("\n\n")
    return {
      message: {
        customType: "council-briefs",
        display: true,
        content:
          `${good.length} council advisor(s) reviewed the user's request before you. Weigh ` +
          `their briefs critically: adopt what is right, discard what is wrong, and fill in ` +
          `what they missed. Do not mention the advisors or this process in your answer.\n\n${body}`
      }
    }
  })

  // ---------------------------------------------------------- check → revise

  pi.on("agent_end", async (event, ctx) => {
    const wasRevision = revising
    revising = false
    if (!cfg.enabled || cfg.checker === null) return
    const checker = resolveModel(ctx, cfg.checker)
    if (checker === undefined) return
    const draft = lastText(event.messages, "assistant")
    const task = lastText(event.messages, "user")
    if (draft.length < 100 || task === "") return
    ctx.ui.setStatus("council", "checking…")
    let verdict: string
    try {
      verdict = (
        await memberChat(
          checker,
          [
            { role: "system", content: CHECKER_SYSTEM },
            {
              role: "user",
              content: `## Task\n${task.slice(0, REQUEST_CLIP)}\n\n## Draft answer\n${draft.slice(0, DRAFT_CLIP)}`
            }
          ],
          { temperature: 0, maxTokens: 2048, timeoutMs: CHECK_TIMEOUT_MS }
        )
      ).trim()
    } catch (e) {
      ctx.ui.setStatus("council", undefined)
      ctx.ui.notify(`council: checker unreachable (${e instanceof Error ? e.message : e})`, "warning")
      return
    }
    if (verdict === "" || /^\**PASS\**\.?$/i.test(verdict)) {
      ctx.ui.setStatus("council", wasRevision ? "✓ revised & passed" : "✓ check passed")
      return
    }
    if (revisionBudget <= 0) {
      ctx.ui.setStatus("council", "✗ violations (revision budget spent)")
      ctx.ui.notify(`council checker findings (not auto-fixed):\n${verdict.slice(0, 600)}`, "warning")
      return
    }
    revisionBudget--
    revising = true
    ctx.ui.setStatus("council", "revising…")
    pi.sendMessage(
      {
        customType: "council-check",
        display: true,
        content:
          `A council reviewer checked your last answer against the user's request and found ` +
          `it violates explicit constraints. Produce the corrected COMPLETE answer: fix every ` +
          `listed violation, change nothing else that already satisfies the request, and do ` +
          `not mention the reviewer or this process.\n\n## Violations\n${verdict.slice(0, 8000)}`
      },
      { triggerTurn: true }
    )
  })

  // --------------------------------------------------------------- /council

  const SUBCOMMANDS = ["on", "off", "status", "advisors", "checker", "revisions", "models", "pick"]

  pi.registerCommand("council", {
    description:
      "Mix-of-models council — on|off|status|advisors <m[:lens],…>|checker <m|off>|revisions <n>|models|pick",
    getArgumentCompletions: (prefix: string) => {
      const parts = prefix.split(/\s+/)
      if (parts.length <= 1) {
        return SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({
          value: s,
          label: s
        }))
      }
      return null
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter((s) => s !== "")
      const restStr = rest.join(" ")

      if (sub === "on" || sub === "off") {
        cfg.enabled = sub === "on"
        saveConfig(cfg)
        if (cfg.enabled) {
          await scoutAutostart(ctx)
          const model = ctx.model as Record<string, unknown> | undefined
          if (model?.["id"] === "ornith-council") {
            ctx.ui.notify(
              "note: the ornith-council engine model already briefs+checks at the proxy; " +
                "consider /model ornith-397b to avoid double council",
              "warning"
            )
          }
        } else {
          ctx.ui.setStatus("council", undefined)
        }
        ctx.ui.notify(await statusText(ctx), "info")
        return
      }

      if (sub === "advisors") {
        if (restStr === "" ) {
          ctx.ui.notify("usage: /council advisors <model[:lens],…> or /council advisors off", "info")
          return
        }
        if (restStr === "off") {
          cfg.advisors = []
        } else {
          const advisors: AdvisorRef[] = []
          for (const spec of restStr.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
            const [ref = "", lens = "scout"] = spec.split(":")
            if (resolveModel(ctx, ref) === undefined) {
              ctx.ui.notify(`unknown or non-openai model: ${ref} (see /council models)`, "error")
              return
            }
            if (!(lens in LENSES)) {
              ctx.ui.notify(`unknown lens: ${lens} (scout | skeptic | architect)`, "error")
              return
            }
            advisors.push({ model: ref, lens })
          }
          cfg.advisors = advisors
        }
        saveConfig(cfg)
        ctx.ui.notify(await statusText(ctx), "info")
        return
      }

      if (sub === "checker") {
        if (restStr === "") {
          ctx.ui.notify("usage: /council checker <model> or /council checker off", "info")
          return
        }
        if (restStr === "off") {
          cfg.checker = null
        } else {
          if (resolveModel(ctx, restStr) === undefined) {
            ctx.ui.notify(`unknown or non-openai model: ${restStr} (see /council models)`, "error")
            return
          }
          cfg.checker = restStr
        }
        saveConfig(cfg)
        ctx.ui.notify(await statusText(ctx), "info")
        return
      }

      if (sub === "revisions") {
        const n = Number(restStr)
        if (!Number.isInteger(n) || n < 0 || n > 3) {
          ctx.ui.notify("usage: /council revisions <0-3>", "info")
          return
        }
        cfg.maxRevisions = n
        saveConfig(cfg)
        ctx.ui.notify(await statusText(ctx), "info")
        return
      }

      if (sub === "models") {
        const models = eligibleModels(ctx)
        const lines = await Promise.all(
          models.map(async (m) => `  ${(await isHealthy(m.baseUrl)) ? "●" : "○"} ${m.ref}`)
        )
        ctx.ui.notify(`eligible models (● = endpoint up):\n${lines.join("\n")}`, "info")
        return
      }

      if (sub === "pick") {
        if (!ctx.hasUI) {
          ctx.ui.notify("pick needs interactive mode; use /council advisors|checker", "warning")
          return
        }
        const models = eligibleModels(ctx)
        const options = models.map((m) => m.ref)
        const advisors: AdvisorRef[] = []
        for (let i = 1; i <= 3; i++) {
          const choice = await ctx.ui.select(
            `Advisor ${i} of up to 3 (${advisors.length} chosen)`,
            [...options, "(done)"]
          )
          if (choice === undefined || choice === "(done)") break
          const lens = (await ctx.ui.select(`Lens for ${choice}`, Object.keys(LENSES))) ?? "scout"
          advisors.push({ model: choice, lens })
        }
        cfg.advisors = advisors
        const checker = await ctx.ui.select("Checker", [...options, "(none)"])
        cfg.checker = checker === undefined || checker === "(none)" ? null : checker
        cfg.enabled = true
        saveConfig(cfg)
        await scoutAutostart(ctx)
        ctx.ui.notify(await statusText(ctx), "info")
        return
      }

      // default: status
      ctx.ui.notify(await statusText(ctx), "info")
    }
  })
}
