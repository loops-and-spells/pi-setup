/**
 * taste: learn the user's preferences from their edits to agent output.
 *
 * The highest-quality preference signal is not what the user says — it is what
 * they change. This extension snapshots every file the agent writes, and when
 * the user later modifies that file (detected before the agent's next write to
 * it, and at session start), the diff is harvested as a correction. Harvested
 * diffs are periodically distilled — one side-channel LLM call to the default
 * model's endpoint — into a short list of durable style rules, which are
 * injected into the system prompt each turn.
 *
 * Injection is ON by default — measured basis (pi-bench taste A/B, 2026-07-10):
 * style-rule adherence 2/24 → 17/24 across Qwen3-4B and Ornith-397B; on the
 * production-tier 397B it cost zero regression on the gated correctness suite
 * (14/23 → 23/23) and *fewer* completion tokens on every task. Injection is
 * inert until rules exist, so the default only matters once learning begins.
 * Disable with `/taste off`.
 *
 * State lives in ~/.pi/agent/taste/ (PI_TASTE_DIR overrides, for tests):
 * config.json, rules.md, pending.jsonl, observations.json, snapshots/.
 */
import { execFileSync } from "node:child_process"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

const tasteDir = (): string =>
  process.env["PI_TASTE_DIR"] ?? path.join(os.homedir(), ".pi/agent/taste")
const agentDir = (): string =>
  process.env["PI_TASTE_AGENT_DIR"] ?? path.join(os.homedir(), ".pi/agent")

interface Config {
  /** Inject learned rules into the system prompt (benched: see header). */
  enabled: boolean
  /** Snapshot agent writes and harvest user-edit diffs. */
  observe: boolean
  maxRules: number
  /** Char budget for the injected rule block. */
  injectChars: number
  /** Distill automatically once this many diffs are pending. */
  distillAfter: number
  /** Model id for the distill call; defaults to pi's default model. */
  distillModel?: string
}

const DEFAULTS: Config = {
  enabled: true,
  observe: true,
  maxRules: 25,
  injectChars: 1800,
  distillAfter: 5
}

const configPath = (): string => path.join(tasteDir(), "config.json")

const loadConfig = (): Config => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<Config>) }
  } catch {
    return { ...DEFAULTS }
  }
}

const saveConfig = (cfg: Config): void => {
  fs.mkdirSync(tasteDir(), { recursive: true })
  fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`)
}

// ---------------------------------------------------------------- pure logic

/** Bullet lines ("- rule" / "* rule") from a rules markdown file. */
export const parseRules = (markdown: string): string[] => {
  const rules: string[] = []
  for (const line of markdown.split("\n")) {
    const m = line.match(/^\s*[-*]\s+(.+?)\s*$/)
    if (m?.[1] !== undefined) rules.push(m[1])
  }
  return rules
}

export const renderRulesFile = (rules: readonly string[]): string =>
  `# Taste — learned user preferences\n\n${rules.map((r) => `- ${r}`).join("\n")}\n`

/**
 * The system-prompt block. pi-bench's taste-on config injects this exact
 * rendering — keep the two in sync so the A/B measures what production ships.
 */
export const renderTasteBlock = (rules: readonly string[], budgetChars: number): string => {
  if (rules.length === 0) return ""
  const header =
    "## Learned user preferences (taste)\n" +
    "Rules learned from this user's past edits to agent-written code. " +
    "Follow them unless the current task explicitly requires otherwise.\n"
  let block = header
  for (const r of rules) {
    const line = `- ${r}\n`
    if (block.length + line.length > budgetChars) break
    block += line
  }
  return block === header ? "" : block.trimEnd()
}

const normalizeRule = (rule: string): string =>
  rule
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()

/** Primary list first (the fresh distillation), then unseen survivors, capped. */
export const mergeRules = (
  primary: readonly string[],
  secondary: readonly string[],
  maxRules: number
): string[] => {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const r of [...primary, ...secondary]) {
    const key = normalizeRule(r)
    if (key === "" || seen.has(key)) continue
    seen.add(key)
    merged.push(r)
    if (merged.length >= maxRules) break
  }
  return merged
}

/** A rule that smells like a credential must never be stored or injected. */
export const looksLikeSecret = (rule: string): boolean =>
  /(key|token|secret|password|bearer|credential)\s*[:=]\s*\S{8,}/i.test(rule) ||
  /\b[A-Za-z0-9+/_-]{32,}\b/.test(rule)

/** Rules from a distiller response: bullets only, bounded length, no secrets. */
export const parseDistilled = (text: string, maxRuleChars = 200): string[] =>
  parseRules(text)
    .map((r) => r.replace(/\*\*/g, "").trim())
    .filter((r) => r.length >= 8 && r.length <= maxRuleChars && !looksLikeSecret(r))

/** Drop diff/index/---/+++ headers; hunks are what carry the signal. */
export const stripDiffHeader = (diff: string): string =>
  diff
    .split("\n")
    .filter((l) => !/^(diff --git |index |--- |\+\+\+ )/.test(l))
    .join("\n")
    .trim()

export interface PendingDiff {
  readonly file: string
  readonly diff: string
  readonly at: string
}

export const distillerMessages = (
  existing: readonly string[],
  diffs: readonly PendingDiff[],
  maxRules: number
): Array<{ role: "system" | "user"; content: string }> => {
  const system =
    "You maintain a short list of durable coding-style preferences for one developer. " +
    "You are given the current rule list and unified diffs of the developer's OWN edits " +
    "to code an AI agent wrote — what they kept, changed, or removed. Extract only " +
    "durable, generalizable preferences: style, structure, naming, error handling, " +
    "library choices, formatting, comment habits. Ignore one-off task-specific fixes, " +
    "bug corrections, and anything that does not generalize beyond the file at hand. " +
    "Never include secrets, credentials, personal data, or file-specific detail. " +
    `Reply with ONLY the complete updated rule list: one rule per line, each starting ` +
    `with "- ", at most ${maxRules} rules, each under 140 characters, most important ` +
    "first. Keep existing rules the diffs do not contradict. If the diffs support no " +
    "new durable rule, reply with the existing list unchanged."
  const rulesBody = existing.length === 0 ? "(none yet)" : existing.map((r) => `- ${r}`).join("\n")
  const diffsBody = diffs
    .map((d) => `### ${d.file} (${d.at.slice(0, 10)})\n\`\`\`diff\n${d.diff}\n\`\`\``)
    .join("\n\n")
  return [
    { role: "system", content: system },
    { role: "user", content: `## Current rules\n${rulesBody}\n\n## Developer edits to agent output\n${diffsBody}` }
  ]
}

// ----------------------------------------------------------- file-backed store

interface Observation {
  /** Snapshot filename under snapshots/. */
  readonly snapshot: string
  readonly at: string
}

const MAX_SNAPSHOT_BYTES = 256 * 1024
const MAX_PENDING = 50
const MAX_DIFF_CHARS = 8000
const OBSERVATION_TTL_DAYS = 30

const observationsPath = (dir: string): string => path.join(dir, "observations.json")
const pendingPath = (dir: string): string => path.join(dir, "pending.jsonl")
const rulesPath = (dir: string): string => path.join(dir, "rules.md")

export const loadObservations = (dir: string): Record<string, Observation> => {
  try {
    return JSON.parse(fs.readFileSync(observationsPath(dir), "utf8")) as Record<string, Observation>
  } catch {
    return {}
  }
}

const saveObservations = (dir: string, obs: Record<string, Observation>): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(observationsPath(dir), `${JSON.stringify(obs, null, 2)}\n`)
}

export const loadPending = (dir: string): PendingDiff[] => {
  try {
    return fs
      .readFileSync(pendingPath(dir), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as PendingDiff)
  } catch {
    return []
  }
}

const savePending = (dir: string, pending: readonly PendingDiff[]): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    pendingPath(dir),
    pending.length === 0 ? "" : `${pending.map((p) => JSON.stringify(p)).join("\n")}\n`
  )
}

export const loadRules = (dir: string): string[] => {
  try {
    return parseRules(fs.readFileSync(rulesPath(dir), "utf8"))
  } catch {
    return []
  }
}

const saveRules = (dir: string, rules: readonly string[]): void => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(rulesPath(dir), renderRulesFile(rules))
}

/** Text files only: snapshotting a binary or a giant file is all cost, no signal. */
const readSnapshotable = (file: string): string | null => {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return null
    const content = fs.readFileSync(file, "utf8")
    return content.includes("\0") ? null : content
  } catch {
    return null
  }
}

/** Record the post-agent-write state of `file` as the new comparison baseline. */
export const recordSnapshot = (dir: string, file: string): void => {
  const content = readSnapshotable(file)
  if (content === null) return
  const name = `${crypto.createHash("sha1").update(file).digest("hex").slice(0, 16)}.snap`
  fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true })
  fs.writeFileSync(path.join(dir, "snapshots", name), content)
  const obs = loadObservations(dir)
  obs[file] = { snapshot: name, at: new Date().toISOString() }
  saveObservations(dir, obs)
}

const gitDiff = (aPath: string, bPath: string): string => {
  try {
    execFileSync("git", ["diff", "--no-index", "--unified=3", "--", aPath, bPath], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000
    })
    return "" // exit 0 = identical
  } catch (e) {
    const out = (e as { stdout?: Buffer }).stdout
    return out === undefined ? "" : out.toString()
  }
}

/**
 * If the user changed `file` since the agent last wrote it, return that diff
 * and refresh the baseline so the same edit is never harvested twice.
 */
export const harvestFile = (dir: string, file: string): PendingDiff | null => {
  const obs = loadObservations(dir)
  const record = obs[file]
  if (record === undefined) return null
  const snapPath = path.join(dir, "snapshots", record.snapshot)
  const current = readSnapshotable(file)
  if (current === null || !fs.existsSync(snapPath)) {
    delete obs[file]
    saveObservations(dir, obs)
    return null
  }
  if (current === fs.readFileSync(snapPath, "utf8")) return null
  const diff = stripDiffHeader(gitDiff(snapPath, file))
  fs.writeFileSync(snapPath, current) // refresh baseline
  obs[file] = { snapshot: record.snapshot, at: new Date().toISOString() }
  saveObservations(dir, obs)
  if (diff === "") return null
  return { file, diff: diff.slice(0, MAX_DIFF_CHARS), at: new Date().toISOString() }
}

export const appendPending = (dir: string, diff: PendingDiff): void => {
  const pending = loadPending(dir)
  pending.push(diff)
  savePending(dir, pending.slice(-MAX_PENDING))
}

/** Harvest every observed file; returns how many new diffs were captured. */
export const harvestAll = (dir: string): number => {
  let captured = 0
  for (const file of Object.keys(loadObservations(dir))) {
    const diff = harvestFile(dir, file)
    if (diff !== null) {
      appendPending(dir, diff)
      captured++
    }
  }
  return captured
}

const pruneObservations = (dir: string): void => {
  const obs = loadObservations(dir)
  const cutoff = Date.now() - OBSERVATION_TTL_DAYS * 24 * 3600 * 1000
  let changed = false
  for (const [file, record] of Object.entries(obs)) {
    if (fs.existsSync(file) && Date.parse(record.at) >= cutoff) continue
    try {
      fs.rmSync(path.join(dir, "snapshots", record.snapshot), { force: true })
    } catch {
      // a stale snapshot never blocks pruning
    }
    delete obs[file]
    changed = true
  }
  if (changed) saveObservations(dir, obs)
}

// ------------------------------------------------------------- distillation

interface DistillEndpoint {
  readonly url: string
  readonly model: string
  readonly apiKey: string
}

/**
 * The distiller talks to whatever pi talks to: default model from
 * settings.json, endpoint from the provider entry in models.json. No
 * machine-specific value lives in this file.
 */
export const resolveEndpoint = (dir: string, modelOverride?: string): DistillEndpoint | null => {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as {
      defaultModel?: string
    }
    const model = modelOverride ?? settings.defaultModel
    if (model === undefined) return null
    const registry = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8")) as {
      providers?: Record<
        string,
        { baseUrl?: string; apiKey?: string; models?: Array<{ id?: string }> }
      >
    }
    for (const provider of Object.values(registry.providers ?? {})) {
      if (provider.baseUrl === undefined) continue
      if (!(provider.models ?? []).some((m) => m.id === model)) continue
      return {
        url: `${provider.baseUrl.replace(/\/$/, "")}/chat/completions`,
        model,
        apiKey: provider.apiKey ?? "none"
      }
    }
    return null
  } catch {
    return null
  }
}

const DISTILL_BATCH = 12
const DISTILL_TIMEOUT_MS = 5 * 60 * 1000

const distill = async (cfg: Config): Promise<{ ok: boolean; detail: string }> => {
  const dir = tasteDir()
  const pending = loadPending(dir)
  if (pending.length === 0) return { ok: true, detail: "nothing pending" }
  const endpoint = resolveEndpoint(agentDir(), cfg.distillModel)
  if (endpoint === null) {
    return { ok: false, detail: "no reachable model endpoint (settings.json/models.json)" }
  }
  const batch = pending.slice(0, DISTILL_BATCH).map((p) => ({ ...p, diff: p.diff.slice(0, 4000) }))
  const existing = loadRules(dir)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DISTILL_TIMEOUT_MS)
  try {
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify({
        model: endpoint.model,
        messages: distillerMessages(existing, batch, cfg.maxRules),
        temperature: 0.2,
        max_tokens: 8192
      }),
      signal: controller.signal
    })
    if (!res.ok) return { ok: false, detail: `distill endpoint HTTP ${res.status}` }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const distilled = parseDistilled(data.choices?.[0]?.message?.content ?? "")
    if (distilled.length === 0) {
      return { ok: false, detail: "distiller returned no usable rules; diffs kept pending" }
    }
    saveRules(dir, mergeRules(distilled, existing, cfg.maxRules))
    savePending(dir, pending.slice(batch.length))
    return { ok: true, detail: `${loadRules(dir).length} rule(s) from ${batch.length} diff(s)` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// ------------------------------------------------------------------ wiring

export default function taste(pi: ExtensionAPI): void {
  const cfg = loadConfig()
  const pendingWrites = new Map<string, string>() // toolCallId → absolute path
  let distilling = false

  const runDistill = async (notify?: (text: string, level: "info" | "warning") => void): Promise<void> => {
    if (distilling) return
    distilling = true
    try {
      const r = await distill(cfg)
      notify?.(`taste: distill ${r.ok ? "✓" : "✗"} — ${r.detail}`, r.ok ? "info" : "warning")
    } finally {
      distilling = false
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!cfg.observe) return
    const captured = harvestAll(tasteDir())
    pruneObservations(tasteDir())
    const pending = loadPending(tasteDir()).length
    if (captured > 0) ctx.ui.setStatus("taste", `${pending} edit(s) pending distill`)
    if (pending >= cfg.distillAfter) {
      void runDistill((text, level) => ctx.ui.notify(text, level))
    }
  })

  pi.on("tool_call", async (event) => {
    if (!cfg.observe) return
    if (event.toolName !== "edit" && event.toolName !== "write") return
    const input = event.input as Record<string, unknown>
    const p = typeof input["path"] === "string" ? input["path"] : input["file_path"]
    if (typeof p !== "string") return
    const abs = path.resolve(p)
    pendingWrites.set(event.toolCallId, abs)
    // the user may have edited this file since the agent last wrote it —
    // harvest that correction before the agent overwrites the evidence
    const diff = harvestFile(tasteDir(), abs)
    if (diff !== null) appendPending(tasteDir(), diff)
  })

  pi.on("tool_execution_end", async (event) => {
    const abs = pendingWrites.get(event.toolCallId)
    if (abs === undefined) return
    pendingWrites.delete(event.toolCallId)
    if (event.isError || !cfg.observe) return
    recordSnapshot(tasteDir(), abs)
  })

  pi.on("before_agent_start", async (event) => {
    if (!cfg.enabled) return
    const block = renderTasteBlock(loadRules(tasteDir()), cfg.injectChars)
    if (block === "") return
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` }
  })

  pi.registerCommand("taste", {
    description: "taste — status|on|off|rules|distill|forget <n|all>|observe on|off",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = "status", value] = args.trim().split(/\s+/).filter((s) => s !== "")
      const dir = tasteDir()
      if (sub === "on" || sub === "off") {
        cfg.enabled = sub === "on"
        saveConfig(cfg)
      } else if (sub === "observe" && (value === "on" || value === "off")) {
        cfg.observe = value === "on"
        saveConfig(cfg)
      } else if (sub === "rules") {
        const rules = loadRules(dir)
        ctx.ui.notify(
          rules.length === 0
            ? "taste: no learned rules yet"
            : rules.map((r, i) => `${i + 1}. ${r}`).join("\n").slice(0, 3000),
          "info"
        )
        return
      } else if (sub === "distill") {
        ctx.ui.setWorkingMessage("taste: distilling pending edits…")
        await runDistill((text, level) => ctx.ui.notify(text, level))
        ctx.ui.setWorkingMessage()
        return
      } else if (sub === "forget" && value !== undefined) {
        const rules = loadRules(dir)
        if (value === "all") {
          saveRules(dir, [])
          ctx.ui.notify(`taste: forgot all ${rules.length} rule(s)`, "info")
        } else {
          const idx = Number(value) - 1
          if (Number.isInteger(idx) && idx >= 0 && idx < rules.length) {
            const [dropped] = rules.splice(idx, 1)
            saveRules(dir, rules)
            ctx.ui.notify(`taste: forgot "${dropped ?? ""}"`, "info")
          } else {
            ctx.ui.notify(`taste: no rule #${value}`, "warning")
          }
        }
        return
      }
      const rules = loadRules(dir)
      const pending = loadPending(dir)
      ctx.ui.notify(
        `taste: inject ${cfg.enabled ? "ON" : "off"} · observe ${cfg.observe ? "on" : "off"} — ` +
          `${rules.length} rule(s), ${pending.length} edit(s) pending distill ` +
          `(auto at ${cfg.distillAfter}), ${cfg.injectChars} char budget`,
        "info"
      )
    }
  })
}
