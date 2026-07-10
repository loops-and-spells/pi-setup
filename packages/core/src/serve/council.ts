import * as fs from "node:fs"
import { Effect } from "effect"
import { draftFormatViolations } from "../draft-checks"
import { paths } from "../paths"

/**
 * ornith-council as a pi engine (invoked by ornith-council.service).
 *
 * The benchmark's best real-work config (284/300 ex-glyph, api-critique
 * 100/100): Ornith-397B chairman + a 2.3GB Qwen3-4B scout that is both
 * advisor and checker. One OpenAI-compatible proxy on :9110 fronts two
 * llama-servers so pi can treat the whole pipeline as a single model:
 *
 *   - model "ornith-council": on a user turn, the scout writes a requirement
 *     checklist brief, Ornith synthesizes with the brief injected, and (in
 *     tool-free chats) the scout checks the answer against the request and
 *     triggers one revision on violations. Tool-call turns pass through so
 *     pi's agentic loop keeps native tool calling.
 *   - model "ornith-397b": direct passthrough, no council overhead.
 *
 * Launch args mirror the bench members in apps/pi-bench/src/council.ts
 * (ornith-397b / qwen3-4b) — keep the two in sync.
 */

const PROXY_PORT = 9110

interface Member {
  readonly id: string
  readonly alias: string
  readonly port: number
  readonly ctx: number
  /** CUDA_VISIBLE_DEVICES for this member; "" = all GPUs. */
  readonly gpus: string
  readonly args: readonly string[]
  readonly readyTimeoutSec: number
}

const ornith: Member = {
  id: "ornith-397b",
  alias: "ornith-397b",
  port: 9103,
  // n_ctx_train = 262144, and MLA keeps KV tiny (1.9GB total at 65536 →
  // ~7.7GB at full ctx, against ~12GB/GPU free) — serve the model's whole
  // trained window. The baked reasoning budget is the proven anti-spiral
  // config (ornith-tuned, 305/400).
  ctx: 262144,
  gpus: "",
  args: ["-ts", "50,50", "--reasoning-budget", "8192"],
  readyTimeoutSec: 1800
}

const scout: Member = {
  id: "qwen3-4b",
  alias: "qwen3-4b",
  port: 9107,
  // n_ctx_train = 32768; the reasoning budget keeps the scout's thinking from
  // starving its own brief/check budgets (unbounded, it spirals — measured)
  ctx: 32768,
  // 2.3GB fits in Ornith's GPU1 margin (verified co-resident in the bench)
  gpus: "1",
  args: ["--reasoning-budget", "1024"],
  readyTimeoutSec: 300
}

const SCOUT_LENS =
  "You are the council's Scout, a small fast model briefing a much stronger one. " +
  "Produce: (1) a checklist of every explicit requirement and constraint in the request, " +
  "quoted exactly; (2) the three hardest parts and why; (3) a terse plan of attack. " +
  "Do NOT write the answer itself."

const CHECKER_SYSTEM =
  "You are a constraint compliance checker. First list every EXPLICIT constraint in the " +
  "request (word counts, required titles or sections, exact output formats, things the answer " +
  "must or must not contain). Then check the draft against each one. If every constraint " +
  "is met, reply with exactly PASS. Otherwise reply with a numbered list of the violated " +
  "constraints only — quote the requirement and state what the draft got wrong. Judge only " +
  "explicit constraints, not quality."

/** Prompt-budget clips (chars ≈ tokens × 3–4): scout ctx is 32768 tokens. */
const REQUEST_CLIP = 40000
const BRIEF_CLIP = 12000
const DRAFT_CLIP = 72000

const BRIEF_TIMEOUT_MS = 3 * 60 * 1000
const CHECK_TIMEOUT_MS = 3 * 60 * 1000
const CHAIRMAN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Escalation ladder: when the checked/revised answer still fails the code
 * checks (draftFormatViolations — spiral signatures), resample fresh drafts
 * sequentially at raised temperature, early-exiting on the first clean one.
 * Measured lift of independent resampling: 0/8 → 8/8 on gate-repo (4B),
 * greedy's dropped check recovered (284B). Sequential because llama-server
 * serializes Ornith anyway. COUNCIL_RESAMPLES=0 disables.
 */
const RESAMPLE_MAX = Number(process.env["COUNCIL_RESAMPLES"] ?? 2)

// ---------------------------------------------------------------------------
// llama-server plumbing
// ---------------------------------------------------------------------------

const spawnMember = (m: Member, gguf: string): Bun.Subprocess => {
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${paths.cudaBin}:${process.env["PATH"] ?? ""}`,
    LD_LIBRARY_PATH: `${paths.cudaLib}:${process.env["LD_LIBRARY_PATH"] ?? ""}`
  }
  // pinned only in the child env — never the manager's (see the ds4 lesson)
  if (m.gpus !== "") env["CUDA_VISIBLE_DEVICES"] = m.gpus
  return Bun.spawn(
    [
      paths.llama.bin,
      "-m", gguf,
      "--alias", m.alias,
      "--host", "127.0.0.1",
      "--port", String(m.port),
      "-ngl", "999",
      "-c", String(m.ctx),
      "--jinja",
      ...m.args
    ],
    { env, stdout: "inherit", stderr: "inherit" }
  )
}

const memberHealthy = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

const waitHealthy = async (m: Member): Promise<boolean> => {
  const started = Date.now()
  while (Date.now() - started < m.readyTimeoutSec * 1000) {
    if (await memberHealthy(m.port)) return true
    await Bun.sleep(3000)
  }
  return false
}

// ---------------------------------------------------------------------------
// OpenAI-shaped helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

interface ChatMessage {
  role?: string
  content?: unknown
  [key: string]: unknown
}

/** Flatten string-or-parts message content to plain text. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof (p as Json)["text"] === "string" ? ((p as Json)["text"] as string) : ""))
      .join("\n")
  }
  return ""
}

const stripThink = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim()

interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

interface MemberReply {
  readonly content: string
  readonly toolCalls: unknown[] | undefined
  readonly usage: Usage
}

const addUsage = (a: Usage, b: Usage): Usage => ({
  prompt_tokens: a.prompt_tokens + b.prompt_tokens,
  completion_tokens: a.completion_tokens + b.completion_tokens,
  total_tokens: a.total_tokens + b.total_tokens
})

const zeroUsage = (): Usage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })

const memberChat = async (
  port: number,
  model: string,
  messages: readonly ChatMessage[],
  opts: { temperature: number; maxTokens: number; timeoutMs: number; tools?: unknown }
): Promise<MemberReply> => {
  const body: Json = {
    model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    stream: false
  }
  if (opts.tools !== undefined) body["tools"] = opts.tools
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs)
  })
  if (!res.ok) throw new Error(`:${port} responded ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] } }>
    usage?: Partial<Usage>
  }
  const message = data.choices?.[0]?.message
  return {
    content: stripThink(message?.content ?? ""),
    toolCalls:
      Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
        ? message.tool_calls
        : undefined,
    usage: {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0
    }
  }
}

// ---------------------------------------------------------------------------
// council pipeline
// ---------------------------------------------------------------------------

interface PipelineResult {
  readonly content: string
  readonly toolCalls: unknown[] | undefined
  readonly usage: Usage
}

/** Append text to a message whose content may be a string or a parts array. */
const withAppended = (msg: ChatMessage, suffix: string): ChatMessage => {
  if (Array.isArray(msg.content)) {
    return { ...msg, content: [...msg.content, { type: "text", text: suffix }] }
  }
  return { ...msg, content: `${textOf(msg.content)}${suffix}` }
}

const runCouncilTurn = async (body: Json): Promise<PipelineResult> => {
  const messages = (Array.isArray(body["messages"]) ? body["messages"] : []) as ChatMessage[]
  const last = messages[messages.length - 1]
  const userText = textOf(last?.content).slice(0, REQUEST_CLIP)
  const temperature = typeof body["temperature"] === "number" ? body["temperature"] : 0.7
  // completion budget must clear the chairman's --reasoning-budget (8192) with
  // room for the answer, or thinking starves the output — the measured
  // "spiral coin flip" was exactly max_tokens == reasoning budget
  const maxTokens = Math.min(
    Math.max(typeof body["max_tokens"] === "number" ? body["max_tokens"] : 32768, 24576),
    65536
  )
  const tools = Array.isArray(body["tools"]) && body["tools"].length > 0 ? body["tools"] : undefined
  const agentic = tools !== undefined || messages.some((m) => m.role === "tool")
  let usage = zeroUsage()
  const t0 = Date.now()

  // 1. scout brief — degrades to a plain chairman call on any failure
  let brief = ""
  try {
    const b = await memberChat(
      scout.port,
      scout.alias,
      [
        { role: "system", content: SCOUT_LENS },
        { role: "user", content: userText }
      ],
      { temperature: 0.7, maxTokens: 4096, timeoutMs: BRIEF_TIMEOUT_MS }
    )
    brief = b.content.slice(0, BRIEF_CLIP)
    usage = addUsage(usage, b.usage)
  } catch (e) {
    console.error(`scout brief failed (continuing without): ${e instanceof Error ? e.message : e}`)
  }

  // 2. chairman synthesis with the brief injected into the last user message
  const synthMessages =
    brief === "" || last === undefined
      ? messages
      : [
          ...messages.slice(0, -1),
          withAppended(
            last,
            `\n\n---\nA fast scout model reviewed this request before you. Weigh its notes ` +
              `critically: adopt what is right, discard what is wrong, and fill in what it ` +
              `missed. Do not mention the scout or this process in your answer.\n\n${brief}`
          )
        ]
  const synthOpts =
    tools === undefined
      ? { temperature, maxTokens, timeoutMs: CHAIRMAN_TIMEOUT_MS }
      : { temperature, maxTokens, timeoutMs: CHAIRMAN_TIMEOUT_MS, tools }
  const draft = await memberChat(ornith.port, ornith.alias, synthMessages, synthOpts)
  usage = addUsage(usage, draft.usage)

  // tool calls end the turn — there is nothing prose-shaped to check yet, and
  // agentic sessions skip the checker (it lacks the tool context to judge)
  if (draft.toolCalls !== undefined || agentic) {
    console.log(`council turn: brief+synth in ${Math.round((Date.now() - t0) / 1000)}s` +
      `${draft.toolCalls !== undefined ? " (tool calls)" : " (agentic, unchecked)"}`)
    return { content: draft.content, toolCalls: draft.toolCalls, usage }
  }

  // 3. scout check → at most one revision
  let final = draft.content
  try {
    const verdict = await memberChat(
      scout.port,
      scout.alias,
      [
        { role: "system", content: CHECKER_SYSTEM },
        { role: "user", content: `## Task\n${userText}\n\n## Draft answer\n${final.slice(0, DRAFT_CLIP)}` }
      ],
      { temperature: 0, maxTokens: 2048, timeoutMs: CHECK_TIMEOUT_MS }
    )
    usage = addUsage(usage, verdict.usage)
    const verdictText = verdict.content.trim()
    if (verdictText !== "" && !/^\**PASS\**\.?$/i.test(verdictText)) {
      const revised = await memberChat(
        ornith.port,
        ornith.alias,
        [
          ...messages.slice(0, -1),
          withAppended(
            last ?? { role: "user", content: "" },
            `\n\n---\nA draft answer follows, and a reviewer found it violates explicit ` +
              `constraints of the request. Produce the corrected COMPLETE answer: fix every ` +
              `listed violation, change nothing else that already satisfies the request, and ` +
              `do not mention the draft or the review.\n\n## Draft\n${final}\n\n## Violations\n${verdictText}`
          )
        ],
        { temperature, maxTokens, timeoutMs: CHAIRMAN_TIMEOUT_MS }
      )
      usage = addUsage(usage, revised.usage)
      // a degenerate or empty revision must never clobber the draft
      const floor = Math.max(200, Math.floor(final.length / 4))
      if (revised.content.trim().length >= floor) final = revised.content
    }
  } catch (e) {
    // a failed check or revision must never cost us the answer — ship the draft
    console.error(`check/revise failed (shipping draft): ${e instanceof Error ? e.message : e}`)
  }

  // 4. resample ladder — only when the answer still trips the code checks
  let violations = draftFormatViolations(userText, final)
  for (let attempt = 1; attempt <= RESAMPLE_MAX && violations.length > 0; attempt++) {
    console.log(
      `council turn: draft fails code checks (${violations.length}), resample ${attempt}/${RESAMPLE_MAX}…`
    )
    try {
      const resample = await memberChat(ornith.port, ornith.alias, synthMessages, {
        temperature: Math.min(1.2, temperature + 0.3 * attempt),
        maxTokens,
        timeoutMs: CHAIRMAN_TIMEOUT_MS
      })
      usage = addUsage(usage, resample.usage)
      const resampleViolations = draftFormatViolations(userText, resample.content)
      // strictly fewer code violations wins; a clean resample ends the ladder
      if (resampleViolations.length < violations.length) {
        final = resample.content
        violations = resampleViolations
      }
    } catch (e) {
      console.error(`resample ${attempt} failed: ${e instanceof Error ? e.message : e}`)
      break
    }
  }

  console.log(`council turn: full pipeline in ${Math.round((Date.now() - t0) / 1000)}s`)
  return { content: final, toolCalls: undefined, usage }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible proxy
// ---------------------------------------------------------------------------

const modelList = (): Json => ({
  object: "list",
  data: [
    { id: "ornith-council", object: "model", created: 0, owned_by: "pi-engine" },
    { id: "ornith-397b", object: "model", created: 0, owned_by: "pi-engine" }
  ]
})

/** Forward the request to Ornith verbatim (model rewritten), streaming and all. */
const passthrough = async (body: Json): Promise<Response> => {
  const upstream = await fetch(`http://127.0.0.1:${ornith.port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, model: ornith.alias })
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" }
  })
}

const completionJson = (r: PipelineResult, created: number, id: string): Json => ({
  id,
  object: "chat.completion",
  created,
  model: "ornith-council",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: r.content,
        ...(r.toolCalls !== undefined ? { tool_calls: r.toolCalls } : {})
      },
      finish_reason: r.toolCalls !== undefined ? "tool_calls" : "stop"
    }
  ],
  usage: r.usage
})

/** Council turns buffer the pipeline, so heartbeat deltas keep the SSE socket alive. */
const streamCouncil = (body: Json): Response => {
  const enc = new TextEncoder()
  const created = Math.floor(Date.now() / 1000)
  const id = `council-${created.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const chunk = (delta: Json, finish: string | null = null, usage?: Usage): string => {
    const c: Json = {
      id,
      object: "chat.completion.chunk",
      created,
      model: "ornith-council",
      choices: [{ index: 0, delta, finish_reason: finish }]
    }
    if (usage !== undefined) c["usage"] = usage
    return `data: ${JSON.stringify(c)}\n\n`
  }
  // the consumer can hang up at any moment (pi cancel, timeout) — every write
  // must survive a closed controller, or one disconnect kills the proxy and
  // unloads 166GB of model (learned 2026-07-06)
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: string): void => {
        if (closed) return
        try {
          controller.enqueue(enc.encode(data))
        } catch {
          closed = true
        }
      }
      const finish = (): void => {
        if (heartbeat !== undefined) clearInterval(heartbeat)
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // consumer already gone
        }
      }
      send(chunk({ role: "assistant" }))
      heartbeat = setInterval(() => send(chunk({})), 10000)
      runCouncilTurn(body)
        .then((r) => {
          if (r.toolCalls !== undefined) {
            const deltas = r.toolCalls.map((tc, i) => ({ index: i, ...(tc as Json) }))
            send(chunk({ tool_calls: deltas }))
            send(chunk({}, "tool_calls", r.usage))
          } else {
            for (let i = 0; i < r.content.length; i += 4000) {
              send(chunk({ content: r.content.slice(i, i + 4000) }))
            }
            send(chunk({}, "stop", r.usage))
          }
          send("data: [DONE]\n\n")
          finish()
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e)
          console.error(`council turn failed: ${msg}`)
          send(chunk({ content: `[council error: ${msg}]` }))
          send(chunk({}, "stop"))
          send("data: [DONE]\n\n")
          finish()
        })
    },
    cancel() {
      closed = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
    }
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    }
  })
}

const handleChat = async (req: Request): Promise<Response> => {
  let body: Json
  try {
    body = (await req.json()) as Json
  } catch {
    return Response.json({ error: { message: "invalid JSON body" } }, { status: 400 })
  }
  const model = typeof body["model"] === "string" ? body["model"] : "ornith-council"
  const messages = (Array.isArray(body["messages"]) ? body["messages"] : []) as ChatMessage[]
  const lastRole = messages[messages.length - 1]?.role
  // the pipeline engages once per user turn; tool-result turns and the
  // passthrough model go straight to Ornith with streaming intact
  if (model !== "ornith-council" || lastRole !== "user") return passthrough(body)
  // huge single-message turns (pi's compaction summarizer, giant pastes) get
  // no value from a 4B brief clipped far below their size — skip the pipeline
  if (textOf(messages[messages.length - 1]?.content).length > REQUEST_CLIP) return passthrough(body)
  if (body["stream"] === true) return streamCouncil(body)
  const r = await runCouncilTurn(body)
  const created = Math.floor(Date.now() / 1000)
  return Response.json(completionJson(r, created, `council-${created.toString(36)}`))
}

// ---------------------------------------------------------------------------
// foreground runner
// ---------------------------------------------------------------------------

export const serveCouncil = (): Effect.Effect<number> =>
  Effect.promise(async () => {
    // a proxy bug must log, not exit: exiting unloads 166GB and costs minutes
    process.on("unhandledRejection", (e) => console.error("unhandled rejection (proxy kept alive):", e))
    process.on("uncaughtException", (e) => console.error("uncaught exception (proxy kept alive):", e))

    for (const [m, gguf] of [
      [ornith, paths.council.ornithGguf],
      [scout, paths.council.scoutGguf]
    ] as const) {
      if (!fs.existsSync(gguf)) {
        console.error(`member ${m.id} model missing: ${gguf}`)
        return 1
      }
    }
    if (!fs.existsSync(paths.llama.bin)) {
      console.error(`llama-server binary missing: ${paths.llama.bin}`)
      return 1
    }

    console.log("Starting council members: ornith-397b, qwen3-4b…")
    const procs = [spawnMember(ornith, paths.council.ornithGguf), spawnMember(scout, paths.council.scoutGguf)]

    let stopping = false
    let exitCode = 0
    const stopped = new Promise<void>((resolve) => {
      const shutdown = (why: string): void => {
        if (stopping) return
        stopping = true
        console.log(`${why}: stopping council members…`)
        for (const p of procs) p.kill("SIGTERM")
        void Promise.all(procs.map((p) => p.exited)).then(() => resolve())
      }
      process.on("SIGTERM", () => shutdown("SIGTERM"))
      process.on("SIGINT", () => shutdown("SIGINT"))
      // a member dying takes the whole engine down so systemd can restart it
      for (const p of procs) {
        void p.exited.then((code) => {
          if (!stopping) {
            exitCode = 1
            shutdown(`member exited unexpectedly (code ${code})`)
          }
        })
      }
    })

    for (const m of [ornith, scout]) {
      if (!(await waitHealthy(m))) {
        console.error(`council member ${m.id} not healthy on :${m.port} within ${m.readyTimeoutSec}s`)
        for (const p of procs) p.kill("SIGTERM")
        await Promise.all(procs.map((p) => p.exited))
        return 1
      }
      console.log(`  ✓ ${m.id} ready on :${m.port}`)
    }

    // council turns buffer for minutes before the first byte; keep sockets open
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: PROXY_PORT,
      idleTimeout: 240,
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        if (url.pathname === "/health") return new Response("ok")
        if (url.pathname === "/v1/models") return Response.json(modelList())
        if (url.pathname === "/v1/chat/completions" && req.method === "POST") return handleChat(req)
        return Response.json({ error: { message: `unsupported route ${url.pathname}` } }, { status: 404 })
      }
    })
    console.log(`✅ ornith-council proxy serving on :${PROXY_PORT} (ornith-council | ornith-397b)`)

    await stopped
    await server.stop(true)
    return exitCode
  })
