import * as fs from "node:fs"
import * as path from "node:path"
import { Console, Effect } from "effect"
import { engines, gpu, health, stopAll, systemd } from "@pi-setup/core"
import { chat } from "./client"
import {
  vllmEngineConfig,
  type BenchConfig,
  type EngineBenchConfig,
  type TechniqueBenchConfig
} from "./configs"
import { gateViolations, runGate } from "./gate"
import { renderFiles } from "./tasks"
import {
  advisors,
  chairman,
  councilMembers,
  member,
  startCouncil,
  stopCouncil,
  type CouncilHandle,
  type CouncilMember
} from "./council"
import type { BenchTask, ChatResult, StageResult, TaskResult } from "./types"

/** Keep synthesis prompts bounded: each brief is clipped to ~3.5k tokens. */
const BRIEF_MAX_CHARS = 12000
/** Advisors that stall (glyph-style thinking spirals) fail fast, not in 30 min. */
const ADVISOR_TIMEOUT_MS = 15 * 60 * 1000

interface Brief {
  readonly id: string
  readonly text: string
}

const failed = (taskId: string, configId: string, error: unknown): TaskResult => ({
  taskId,
  configId,
  output: "",
  reasoning: "",
  wallMs: 0,
  completionTokens: 0,
  stages: [],
  error: error instanceof Error ? error.message : String(error)
})

const clip = (text: string): string =>
  text.length > BRIEF_MAX_CHARS ? `${text.slice(0, BRIEF_MAX_CHARS)}\n[…brief clipped]` : text

/** Collect briefs in parallel; a failed or empty brief degrades, never aborts. */
const collectBriefs = async (
  who: readonly CouncilMember[],
  task: BenchTask,
  stages: StageResult[]
): Promise<Brief[]> => {
  const results = await Promise.all(
    who.map(async (a) => {
      try {
        const r = await chat({
          port: a.port,
          model: a.alias,
          messages: [
            { role: "system", content: a.lens },
            { role: "user", content: task.prompt }
          ],
          temperature: task.temperature,
          maxTokens: a.briefMaxTokens,
          timeoutMs: ADVISOR_TIMEOUT_MS
        })
        stages.push({ stage: `advisor:${a.id}`, metrics: r.metrics, content: r.content })
        return r.content.trim() === "" ? null : { id: a.id, text: clip(r.content) }
      } catch (e) {
        stages.push({
          stage: `advisor:${a.id}`,
          metrics: { wallMs: 0, promptTokens: 0, completionTokens: 0, tokensPerSec: 0 },
          content: `[brief failed: ${e instanceof Error ? e.message : String(e)}]`
        })
        return null
      }
    })
  )
  return results.filter((b): b is Brief => b !== null)
}

const synthesisPrompt = (task: BenchTask, briefs: readonly Brief[]): string => {
  if (briefs.length === 0) return task.prompt
  const body = briefs.map((d, i) => `### Advisor ${i + 1} (${d.id})\n${d.text}`).join("\n\n")
  return (
    `${task.prompt}\n\n---\n` +
    `${briefs.length} advisor(s) reviewed this task before you. Their briefs follow. Weigh ` +
    `them critically: adopt what is right, discard what is wrong, and fill in what they ` +
    `missed. Produce the single best complete answer to the task above. Do not mention ` +
    `the advisors or this process in your answer.\n\n${body}`
  )
}

/**
 * Run the deliverable for real: largest python block = interpreter, remaining
 * fenced blocks form (program, expected-output) pairs. Every crash, hang, or
 * output mismatch becomes a violation the revision prompt can act on.
 */
export const execViolations = (draft: string): string[] => {
  const blocks = [...draft.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
  if (blocks.length < 3) {
    return [
      "The deliverable must contain, as fenced code blocks: the Python interpreter and each " +
        "example program followed by its exact expected output. Too few complete fenced " +
        "blocks were found — the answer may be truncated or unfenced."
    ]
  }
  const interpreter = blocks.reduce((a, b) => (b.length > a.length ? b : a))
  // only blocks inside the example sections count as test cases — documentation
  // snippets elsewhere in the answer must not be executed
  const exampleZone = draft.slice(draft.search(/#+ .*(Example|\(a\))/i))
  const zoneBlocks = [...exampleZone.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
  const rest = (zoneBlocks.length >= 2 ? zoneBlocks : blocks).filter((b) => b !== interpreter).slice(0, 6)
  const dir = fs.mkdtempSync("/tmp/pi-bench-exec-")
  const interpPath = path.join(dir, "interp.py")
  fs.writeFileSync(interpPath, interpreter)
  const violations: string[] = []
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const prog = rest[i] ?? ""
    const expected = (rest[i + 1] ?? "").replace(/\s+$/, "")
    const progPath = path.join(dir, `prog${i}.gly`)
    fs.writeFileSync(progPath, prog.replace(/\s+$/, ""))
    const run = Bun.spawnSync(["timeout", "10", "python3", interpPath, progPath], {
      stdout: "pipe",
      stderr: "pipe"
    })
    const actual = new TextDecoder().decode(run.stdout).replace(/\s+$/, "")
    const err = new TextDecoder().decode(run.stderr).trim()
    const label = `Example ${i / 2 + 1} (program starting "${prog.trim().slice(0, 30)}…")`
    if (run.exitCode === 124) {
      violations.push(`${label}: never terminates (10s timeout) — likely an infinite loop in the program or interpreter.`)
    } else if (run.exitCode !== 0) {
      violations.push(`${label}: interpreter crashed: ${err.split("\n").pop() ?? "unknown error"}`)
    } else if (actual !== expected) {
      violations.push(
        `${label}: output mismatch. Expected exactly:\n${expected.slice(0, 300)}\nGot:\n${actual.slice(0, 300) || "(empty)"}`
      )
    }
  }
  if (rest.length < 2) {
    violations.push("No (program, expected output) block pairs found after the interpreter block.")
  }
  return violations
}

/** Machine-checkable violations — computed in code, never trusted to a model. */
const deterministicViolations = (task: BenchTask, draft: string): string[] => {
  const hc = task.hardConstraints
  if (hc === undefined) return []
  const violations: string[] = []
  for (const s of hc.requiredStrings ?? []) {
    if (!draft.includes(s)) violations.push(`The answer must contain "${s}" verbatim, but it does not.`)
  }
  if (hc.execExamples === true) violations.push(...execViolations(draft))
  if (hc.wordRange !== undefined) {
    const wr = hc.wordRange
    let scope = wr.beforeMarker !== undefined ? draft.split(wr.beforeMarker)[0] ?? draft : draft
    for (const p of wr.stripPatterns ?? []) scope = scope.replace(new RegExp(p, "g"), "")
    const words = (scope.match(/[A-Za-z0-9'’-]+/g) ?? []).length
    if (words < wr.min || words > wr.max) {
      violations.push(
        `The word count must be between ${wr.min} and ${wr.max}` +
          `${wr.beforeMarker !== undefined ? ` (counted before "${wr.beforeMarker}")` : ""}; ` +
          `the draft has ${words} words.`
      )
    }
  }
  return violations
}

const CHECKER_SYSTEM =
  "You are a constraint compliance checker. First list every EXPLICIT constraint in the " +
  "task (word counts, required titles or sections, exact output formats, things the answer " +
  "must or must not contain). Then check the draft against each one. If every constraint " +
  "is met, reply with exactly PASS. Otherwise reply with a numbered list of the violated " +
  "constraints only — quote the requirement and state what the draft got wrong. Judge only " +
  "explicit constraints, not quality."

const checkerPrompt = (task: BenchTask, draft: string): string =>
  `## Task\n${task.prompt}\n\n## Draft answer\n${draft}`

export const revisionPrompt = (task: BenchTask, draft: string, violations: string): string =>
  `${task.prompt}\n\n---\nA draft answer follows, and a reviewer found it violates explicit ` +
  `constraints of the task. Produce the corrected COMPLETE answer: fix every listed ` +
  `violation, change nothing else that already satisfies the task, and do not mention the ` +
  `draft or the review.\n\n## Draft\n${draft}\n\n## Violations\n${violations}`

interface Endpoint {
  readonly port: number
  readonly model: string
  readonly stageName: string
  /** Hard cap on any single completion, so prompt + completion fit the ctx. */
  readonly completionCap?: number
}

const capped = (ep: Endpoint, want: number): number =>
  ep.completionCap === undefined ? want : Math.min(want, ep.completionCap)

/** Chairman generation can stall (glyph-style crawl); bound it and retry once. */
const CHAIRMAN_TIMEOUT_MS = 12 * 60 * 1000
/** Revisions re-read punctuation-dense drafts, which slows generation ~5×; one long attempt. */
const REVISION_TIMEOUT_MS = 25 * 60 * 1000

const chairmanChat = async (
  synth: Endpoint,
  content: string,
  task: BenchTask,
  mode: "draft" | "revision" = "draft"
): Promise<ChatResult> => {
  const opts = {
    port: synth.port,
    model: synth.model,
    messages: [{ role: "user" as const, content }],
    temperature: task.temperature,
    maxTokens: capped(synth, task.maxTokens),
    timeoutMs: mode === "revision" ? REVISION_TIMEOUT_MS : CHAIRMAN_TIMEOUT_MS
  }
  try {
    return await chat(opts)
  } catch (e) {
    if (mode === "revision" || !(e instanceof Error && /timed?\s?out/i.test(e.message))) throw e
    return chat(opts) // fresh sample — draft stalls are stochastic
  }
}

/** synthesize → constraint-check (code + LLM) → revise, up to `rounds` times. */
const synthesizeChecked = async (
  task: BenchTask,
  briefs: readonly Brief[],
  synth: Endpoint,
  checker: Endpoint,
  stages: StageResult[]
): Promise<ChatResult> => {
  let current = await chairmanChat(synth, synthesisPrompt(task, briefs), task)
  stages.push({ stage: `chairman:${synth.stageName}`, metrics: current.metrics, content: "" })

  // execution feedback earns extra repair rounds; prose gets one
  const rounds = task.hardConstraints?.execExamples === true ? 2 : 1
  for (let round = 0; round < rounds; round++) {
    const hardViolations = deterministicViolations(task, current.content)
    let verdictText = "PASS"
    if (round === 0) {
      // the LLM checker runs once; code checks run every round
      try {
        const verdict = await chat({
          port: checker.port,
          model: checker.model,
          messages: [
            { role: "system", content: CHECKER_SYSTEM },
            { role: "user", content: checkerPrompt(task, current.content) }
          ],
          temperature: 0,
          maxTokens: 4096
        })
        stages.push({ stage: `checker:${checker.stageName}`, metrics: verdict.metrics, content: verdict.content })
        verdictText = verdict.content.trim()
      } catch {
        // checker unavailable → deterministic violations alone can still force revision
      }
    }
    const llmPassed = verdictText === "" || /^\**PASS\**\.?$/i.test(verdictText)
    if (hardViolations.length === 0 && llmPassed) return current

    // deterministic findings outrank a rubber-stamp PASS
    const allViolations = [
      ...hardViolations.map((v, i) => `${i + 1}. ${v}`),
      ...(llmPassed ? [] : [verdictText])
    ].join("\n")

    let revised: ChatResult
    try {
      revised = await chairmanChat(synth, revisionPrompt(task, current.content, allViolations), task, "revision")
    } catch {
      // a failed repair must never cost us the deliverable — ship the draft
      return current
    }
    // persist the pre-revision draft so a bad revision can never destroy it
    stages.push({ stage: `revision:${synth.stageName}`, metrics: revised.metrics, content: current.content })
    // a revision that is empty or degenerately short (e.g. the chairman answering
    // "PASS" to the violations list) must not clobber the draft
    const floor = Math.max(200, Math.floor(current.content.length / 4))
    if (revised.content.trim().length >= floor) current = revised
  }
  return current
}

/** Stages that run concurrently (advisor briefs, best-of-N candidates) cost max, not sum. */
const PARALLEL_STAGE = /^(advisor|candidate):/

const toResult = (
  taskId: string,
  configId: string,
  final: ChatResult,
  stages: readonly StageResult[]
): TaskResult => {
  const advisorWallMs = Math.max(
    0,
    ...stages.filter((s) => PARALLEL_STAGE.test(s.stage)).map((s) => s.metrics.wallMs)
  )
  const serialWallMs = stages
    .filter((s) => !PARALLEL_STAGE.test(s.stage))
    .reduce((sum, s) => sum + s.metrics.wallMs, 0)
  return {
    taskId,
    configId,
    output: final.content,
    reasoning: final.reasoning,
    wallMs: advisorWallMs + serialWallMs,
    completionTokens: stages.reduce((sum, s) => sum + s.metrics.completionTokens, 0),
    stages
  }
}

// ---------------------------------------------------------------------------
// per-config task runners
// ---------------------------------------------------------------------------

const runEngineTask = async (cfg: EngineBenchConfig, task: BenchTask): Promise<TaskResult> => {
  const r = await chat({
    port: cfg.port,
    model: cfg.model,
    messages: [{ role: "user", content: task.prompt }],
    temperature: task.temperature,
    maxTokens: task.maxTokens
  })
  return toResult(task.id, cfg.id, r, [{ stage: cfg.model, metrics: r.metrics, content: "" }])
}

const runSolo = async (m: CouncilMember, configId: string, task: BenchTask): Promise<TaskResult> => {
  const r = await chat({
    port: m.port,
    model: m.alias,
    messages: [{ role: "user", content: task.prompt }],
    temperature: task.temperature,
    // prompt + completion must fit the member's ctx window
    maxTokens: Math.min(task.maxTokens, m.ctx - 8192)
  })
  return toResult(task.id, configId, r, [{ stage: m.id, metrics: r.metrics, content: "" }])
}

// ---------------------------------------------------------------------------
// technique runners — harness techniques A/B'd on one endpoint (vllm)
// ---------------------------------------------------------------------------

const TECHNIQUE_TIMEOUT_MS = 12 * 60 * 1000

const vllmEndpoint: Endpoint = {
  port: vllmEngineConfig.port,
  model: vllmEngineConfig.model,
  stageName: vllmEngineConfig.model
}

/**
 * All violations we can compute in code for a draft: hidden-gate results
 * (behavior) + hard constraints (format). The verify loop and best-of-N
 * selection both rank on these — models never see the gate's test source,
 * only failing check names and error text (what a real test run prints).
 */
const codeViolations = (task: BenchTask, draft: string): string[] => [
  ...(task.gate !== undefined ? gateViolations(runGate(task, draft)) : []),
  ...deterministicViolations(task, draft)
]

/** best-of-N: N independent candidates at spread temperatures, ranked by code checks. */
const runBestOfN = async (task: BenchTask, n: number): Promise<TaskResult> => {
  const temps = [Math.max(task.temperature, 0.2), 0.7, 1.0].slice(0, n)
  const stages: StageResult[] = []
  const candidates = (
    await Promise.all(
      temps.map(async (temperature, i) => {
        try {
          const r = await chat({
            port: vllmEndpoint.port,
            model: vllmEndpoint.model,
            messages: [{ role: "user", content: task.prompt }],
            temperature,
            maxTokens: task.maxTokens,
            timeoutMs: TECHNIQUE_TIMEOUT_MS
          })
          stages.push({ stage: `candidate:${i}@t${temperature}`, metrics: r.metrics, content: "" })
          return { r, i }
        } catch {
          return null
        }
      })
    )
  ).filter((c): c is { r: ChatResult; i: number } => c !== null)
  if (candidates.length === 0) throw new Error("all best-of-n candidates failed")

  const ranked = candidates
    .map((c) => ({ ...c, violations: codeViolations(task, c.r.content).length }))
    .sort(
      (a, b) =>
        a.violations - b.violations ||
        a.r.metrics.completionTokens - b.r.metrics.completionTokens
    )
  let winner = ranked[0] as (typeof ranked)[number]

  // code checks can't split a tie on judged (non-gated) tasks — one LLM pick, temp 0
  const tied = ranked.filter((c) => c.violations === winner.violations)
  if (tied.length > 1 && task.gate === undefined) {
    try {
      const letters = tied.map((_, i) => String.fromCharCode(65 + i))
      const body = tied
        .map((c, i) => `## Answer ${letters[i]}\n${clip(c.r.content)}`)
        .join("\n\n")
      const pick = await chat({
        port: vllmEndpoint.port,
        model: vllmEndpoint.model,
        messages: [
          {
            role: "system",
            content:
              "You are ranking candidate answers to the same task. Reply with ONLY the single " +
              "letter of the best answer: most correct, most complete, and exactly following " +
              "the task's format constraints."
          },
          { role: "user", content: `# Task\n${task.prompt}\n\n${body}` }
        ],
        temperature: 0,
        maxTokens: 512,
        timeoutMs: TECHNIQUE_TIMEOUT_MS
      })
      stages.push({ stage: "selector", metrics: pick.metrics, content: pick.content })
      const idx = letters.indexOf((pick.content.trim().match(/[A-Z]/)?.[0] ?? "A").toUpperCase())
      if (idx >= 0) winner = tied[idx] as (typeof ranked)[number]
    } catch {
      // selector failure keeps the code-ranked winner
    }
  }
  return toResult(task.id, "vllm-bo3", winner.r, stages)
}

/** verify-loop: draft → run code checks → feed failures back → revise, up to `rounds`. */
const runVerifyLoop = async (task: BenchTask, rounds: number): Promise<TaskResult> => {
  const stages: StageResult[] = []
  let current = await chairmanChat(vllmEndpoint, task.prompt, task)
  stages.push({ stage: `draft:${vllmEndpoint.stageName}`, metrics: current.metrics, content: "" })
  for (let round = 0; round < rounds; round++) {
    const violations = codeViolations(task, current.content)
    if (violations.length === 0) break
    let revised: ChatResult
    try {
      revised = await chairmanChat(
        vllmEndpoint,
        revisionPrompt(task, current.content, violations.map((v, i) => `${i + 1}. ${v}`).join("\n")),
        task,
        "revision"
      )
    } catch {
      break // a failed repair must never cost us the deliverable
    }
    stages.push({ stage: `revision:${round + 1}`, metrics: revised.metrics, content: current.content })
    const floor = Math.max(200, Math.floor(current.content.length / 4))
    if (revised.content.trim().length >= floor) current = revised
    else break // degenerate revision — further feedback on it would be noise
  }
  return toResult(task.id, "vllm-verify", current, stages)
}

/** greedy sampler A/B: identical single shot, temperature 0. */
const runGreedy = async (task: BenchTask): Promise<TaskResult> => {
  const r = await chat({
    port: vllmEndpoint.port,
    model: vllmEndpoint.model,
    messages: [{ role: "user", content: task.prompt }],
    temperature: 0,
    maxTokens: task.maxTokens,
    timeoutMs: TECHNIQUE_TIMEOUT_MS
  })
  return toResult(task.id, "vllm-greedy", r, [
    { stage: `greedy:${vllmEndpoint.stageName}`, metrics: r.metrics, content: "" }
  ])
}

/**
 * Compact symbol map: signatures + docstrings, no bodies. What a repo-map
 * harness would inject instead of whole files.
 */
export const symbolMap = (files: Readonly<Record<string, string>>): string => {
  const out: string[] = []
  for (const [rel, content] of Object.entries(files)) {
    out.push(`### \`${rel}\``)
    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      const sig = line.match(/^(\s*)(?:class|def)\s.*$/)
      if (sig === null) continue
      let entry = line.trim()
      // multi-line signatures: append until the line that closes with ':'
      let j = i
      while (!/[:]\s*(#.*)?$/.test(lines[j] ?? "") && j < i + 5) {
        j++
        entry += ` ${(lines[j] ?? "").trim()}`
      }
      const doc = (lines[j + 1] ?? "").trim().match(/^[ru]*["']{3}(.*?)(?:["']{3})?$/)
      out.push(doc?.[1] !== undefined && doc[1] !== "" ? `- \`${entry}\` — ${doc[1]}` : `- \`${entry}\``)
    }
    out.push("")
  }
  return out.join("\n")
}

/** ctx experiment: same task, three context renderings — none / symbol map / full files. */
const runContextVariant = async (
  task: BenchTask,
  configId: string,
  mode: "none" | "map" | "full"
): Promise<TaskResult> => {
  const rc = task.repoContext
  const base = task.rawPrompt
  if (rc === undefined || base === undefined) {
    throw new Error(`${configId} needs a repoContext task`)
  }
  const target = { [rc.target]: rc.files[rc.target] ?? "" }
  const others = Object.fromEntries(Object.entries(rc.files).filter(([k]) => k !== rc.target))
  const context =
    mode === "none"
      ? renderFiles(target)
      : mode === "map"
        ? `${renderFiles(target)}\n\n## Other project files (symbol map)\n\n${symbolMap(others)}`
        : renderFiles(rc.files)
  const r = await chat({
    port: vllmEndpoint.port,
    model: vllmEndpoint.model,
    messages: [{ role: "user", content: `${base}\n\n## Project files\n\n${context}` }],
    temperature: task.temperature,
    maxTokens: task.maxTokens,
    timeoutMs: TECHNIQUE_TIMEOUT_MS
  })
  return toResult(task.id, configId, r, [{ stage: `ctx-${mode}`, metrics: r.metrics, content: "" }])
}

const runTechniqueTask = (cfg: TechniqueBenchConfig, task: BenchTask): Promise<TaskResult> => {
  switch (cfg.technique) {
    case "bo3":
      return runBestOfN(task, 3)
    case "verify":
      return runVerifyLoop(task, 3)
    case "greedy":
      return runGreedy(task)
    case "ctx-none":
    case "ctx-map":
    case "ctx-full":
      return runContextVariant(task, cfg.id, cfg.technique.slice(4) as "none" | "map" | "full")
  }
}

/** v1: advisors → chairman synthesis, no verification. */
const runCouncilTask = async (task: BenchTask): Promise<TaskResult> => {
  const stages: StageResult[] = []
  const briefs = await collectBriefs(advisors(), task, stages)
  const c = chairman()
  const final = await chat({
    port: c.port,
    model: c.alias,
    messages: [{ role: "user", content: synthesisPrompt(task, briefs) }],
    temperature: task.temperature,
    maxTokens: task.maxTokens
  })
  stages.push({ stage: `chairman:${c.id}`, metrics: final.metrics, content: "" })
  return toResult(task.id, "council", final, stages)
}

/** v2 pipeline: advisors → chairman synthesis → constraint-check → one revision. */
const runCheckedCouncil = async (
  configId: string,
  chair: CouncilMember,
  panel: readonly CouncilMember[],
  checker: CouncilMember,
  task: BenchTask
): Promise<TaskResult> => {
  const stages: StageResult[] = []
  const briefs = await collectBriefs(panel, task, stages)
  const final = await synthesizeChecked(
    task,
    briefs,
    // cap keeps prompt (task + clipped briefs / draft + violations) + completion < chair ctx
    { port: chair.port, model: chair.alias, stageName: chair.id, completionCap: chair.ctx - 16384 },
    { port: checker.port, model: checker.alias, stageName: checker.id },
    stages
  )
  return toResult(task.id, configId, final, stages)
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

const runTasksFor = (
  configId: string,
  tasks: readonly BenchTask[],
  exec: (task: BenchTask) => Promise<TaskResult>
): Effect.Effect<readonly TaskResult[]> =>
  Effect.gen(function* () {
    const results: TaskResult[] = []
    for (const task of tasks) {
      yield* Console.log(`  [${configId}] ${task.id}…`)
      let r = yield* Effect.promise(() => exec(task).catch((e) => failed(task.id, configId, e)))
      // every config gets the same objective score when the task has a gate
      if (task.gate !== undefined && r.error === undefined) {
        r = { ...r, gate: runGate(task, r.output) }
      }
      results.push(r)
      const gateNote =
        r.gate !== undefined ? `, gate ${r.gate.passed}/${r.gate.total}` : ""
      yield* Console.log(
        r.error !== undefined
          ? `  [${configId}] ${task.id} ✗ ${r.error}`
          : `  [${configId}] ${task.id} ✓ ${Math.round(r.wallMs / 1000)}s, ${r.completionTokens} tok${gateNote}`
      )
    }
    return results
  })

/**
 * Everything that needs the council servers happens in one spin-up:
 * chairman-solo, council v1, council v2, and council-vllm's brief collection
 * (MiniMax as Architect + gemma as Skeptic advising the absent vLLM chairman).
 */
const runCouncilSession = (
  configs: readonly BenchConfig[],
  tasks: readonly BenchTask[]
): Effect.Effect<
  { results: readonly TaskResult[]; vllmBriefs: Map<string, { briefs: Brief[]; stages: StageResult[] }> },
  Error
> =>
  Effect.gen(function* () {
    const want = (kind: string): boolean => configs.some((c) => c.kind === kind)
    const vllmBriefs = new Map<string, { briefs: Brief[]; stages: StageResult[] }>()
    if (!want("chairman-solo") && !want("council") && !want("council-v2") && !want("council-vllm")) {
      return { results: [], vllmBriefs }
    }

    yield* stopAll({ includeLmStudio: false })
    yield* gpu.waitVramFree()
    const handle: CouncilHandle = yield* startCouncil(councilMembers)

    const results: TaskResult[] = []
    try {
      if (want("chairman-solo")) {
        results.push(
          ...(yield* runTasksFor("chairman-solo", tasks, (t) => runSolo(chairman(), "chairman-solo", t)))
        )
      }
      if (want("council")) results.push(...(yield* runTasksFor("council", tasks, runCouncilTask)))
      if (want("council-v2")) {
        results.push(
          ...(yield* runTasksFor("council-v2", tasks, (t) =>
            runCheckedCouncil("council-v2", chairman(), advisors(), member("qwen3.6-35b-a3b"), t)
          ))
        )
      }
      if (want("council-vllm")) {
        const panel = [member("minimax-m2.7"), member("gemma-4-31b")]
        for (const task of tasks) {
          yield* Console.log(`  [council-vllm] ${task.id} briefs…`)
          const stages: StageResult[] = []
          const briefs = yield* Effect.promise(() => collectBriefs(panel, task, stages))
          vllmBriefs.set(task.id, { briefs, stages })
          yield* Console.log(`  [council-vllm] ${task.id} briefs ✓ ${briefs.length}/${panel.length}`)
        }
      }
    } finally {
      yield* Console.log("Stopping council members…")
      yield* stopCouncil(handle)
    }
    return { results, vllmBriefs }
  })

/** Stop everything else, start the engine's unit, and gate on health. */
const ensureEngine = (cfg: EngineBenchConfig): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const eng = engines[cfg.engine]
    if ((yield* systemd.isActive(eng.unit)) && (yield* health.isHealthy(eng.port))) {
      yield* Console.log(`${eng.title} already healthy.`)
      return
    }
    yield* stopAll({ includeLmStudio: false })
    yield* gpu.waitVramFree()
    yield* Console.log(`Starting ${eng.unit}…`)
    yield* systemd.start(eng.unit).pipe(Effect.mapError((e) => new Error(e.message)))
    const ready = yield* health.waitHealthy(eng.title, eng.port, eng.readyTimeoutSec)
    if (!ready) {
      return yield* Effect.fail(new Error(`${eng.title} not healthy in ${eng.readyTimeoutSec}s`))
    }
  })

/** council-vllm phase B: vLLM synthesizes from stored briefs, then self-checks. */
const runCouncilVllmTask = async (
  task: BenchTask,
  stored: { briefs: Brief[]; stages: StageResult[] } | undefined
): Promise<TaskResult> => {
  const stages: StageResult[] = [...(stored?.stages ?? [])]
  const ep: Endpoint = {
    port: vllmEngineConfig.port,
    model: vllmEngineConfig.model,
    stageName: vllmEngineConfig.model
  }
  const final = await synthesizeChecked(task, stored?.briefs ?? [], ep, ep, stages)
  return toResult(task.id, "council-vllm", final, stages)
}

/** One spin-up serving a custom member set, running solo/checked configs on it. */
const runCustomSession = (
  members: readonly CouncilMember[],
  runs: ReadonlyArray<{ configId: string; exec: (t: BenchTask) => Promise<TaskResult> }>,
  tasks: readonly BenchTask[]
): Effect.Effect<readonly TaskResult[], Error> =>
  Effect.gen(function* () {
    yield* stopAll({ includeLmStudio: false })
    yield* gpu.waitVramFree()
    const handle = yield* startCouncil(members)
    const results: TaskResult[] = []
    try {
      for (const r of runs) results.push(...(yield* runTasksFor(r.configId, tasks, r.exec)))
    } finally {
      yield* Console.log("Stopping session members…")
      yield* stopCouncil(handle)
    }
    return results
  })

export const runBench = (
  configs: readonly BenchConfig[],
  tasks: readonly BenchTask[]
): Effect.Effect<readonly TaskResult[], Error> =>
  Effect.gen(function* () {
    const results: TaskResult[] = []
    const has = (id: string): boolean => configs.some((c) => c.id === id)
    const council = yield* runCouncilSession(configs, tasks)
    results.push(...council.results)

    if (has("ornith-solo") || has("ornith-council")) {
      const ornith = member("ornith-397b")
      const scout = member("qwen3-4b")
      const members = has("ornith-council") ? [ornith, scout] : [ornith]
      const runs: Array<{ configId: string; exec: (t: BenchTask) => Promise<TaskResult> }> = []
      if (has("ornith-solo")) {
        runs.push({ configId: "ornith-solo", exec: (t) => runSolo(ornith, "ornith-solo", t) })
      }
      if (has("ornith-council")) {
        // the 2.3GB scout is both advisor and checker — the smallest possible council
        runs.push({
          configId: "ornith-council",
          exec: (t) => runCheckedCouncil("ornith-council", ornith, [scout], scout, t)
        })
      }
      results.push(...(yield* runCustomSession(members, runs, tasks)))
    }

    if (has("qcn-solo") || has("qcn-council") || has("gemma-solo") || has("devstral-solo")) {
      const qcn = member("qwen3-coder-next")
      const devstral = member("devstral-2-123b")
      const gemma = member("gemma-4-31b")
      const runs: Array<{ configId: string; exec: (t: BenchTask) => Promise<TaskResult> }> = []
      if (has("qcn-solo")) {
        runs.push({ configId: "qcn-solo", exec: (t) => runSolo(qcn, "qcn-solo", t) })
      }
      if (has("gemma-solo")) {
        runs.push({ configId: "gemma-solo", exec: (t) => runSolo(gemma, "gemma-solo", t) })
      }
      if (has("devstral-solo")) {
        runs.push({ configId: "devstral-solo", exec: (t) => runSolo(devstral, "devstral-solo", t) })
      }
      if (has("qcn-council")) {
        // gemma advises AND checks — independent of the chairman either way
        runs.push({
          configId: "qcn-council",
          exec: (t) => runCheckedCouncil("qcn-council", qcn, [devstral, gemma], gemma, t)
        })
      }
      results.push(...(yield* runCustomSession([qcn, devstral, gemma], runs, tasks)))
    }

    if (has("qwen36-solo") || has("devstral-council")) {
      const chair = member("devstral-2-chair")
      const gemma = member("gemma-4-31b")
      const qwen = member("qwen3.6-35b-a3b")
      const runs: Array<{ configId: string; exec: (t: BenchTask) => Promise<TaskResult> }> = []
      if (has("qwen36-solo")) {
        runs.push({ configId: "qwen36-solo", exec: (t) => runSolo(qwen, "qwen36-solo", t) })
      }
      if (has("devstral-council")) {
        runs.push({
          configId: "devstral-council",
          exec: (t) => runCheckedCouncil("devstral-council", chair, [gemma, qwen], qwen, t)
        })
      }
      results.push(...(yield* runCustomSession([chair, gemma, qwen], runs, tasks)))
    }

    for (const cfg of configs) {
      if (cfg.kind !== "engine") continue
      yield* ensureEngine(cfg)
      results.push(...(yield* runTasksFor(cfg.id, tasks, (t) => runEngineTask(cfg, t))))
    }

    if (configs.some((c) => c.kind === "council-vllm")) {
      yield* ensureEngine(vllmEngineConfig)
      results.push(
        ...(yield* runTasksFor("council-vllm", tasks, (t) =>
          runCouncilVllmTask(t, council.vllmBriefs.get(t.id))
        ))
      )
    }

    const techniques = configs.filter((c): c is TechniqueBenchConfig => c.kind === "technique")
    if (techniques.length > 0) {
      yield* ensureEngine(vllmEngineConfig)
      for (const cfg of techniques) {
        // ctx variants only mean something on multi-file tasks
        const applicable = cfg.technique.startsWith("ctx-")
          ? tasks.filter((t) => t.repoContext !== undefined)
          : tasks
        if (applicable.length === 0) {
          yield* Console.log(`  [${cfg.id}] skipped: no repoContext tasks in this run`)
          continue
        }
        results.push(...(yield* runTasksFor(cfg.id, applicable, (t) => runTechniqueTask(cfg, t))))
      }
    }
    return results
  })
