import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Console, Effect } from "effect"
import { health, paths } from "@pi-setup/core"

const home = os.homedir()
/** Agnostic model store: one directory per model, no launcher-specific nesting. */
const ggufDir = path.join(home, "Machine/models/gguf")
const llamaBin = process.env["LLAMA_BIN"] ?? path.join(home, "src/llama.cpp-v4/build/bin/llama-server")

export interface CouncilMember {
  readonly id: string
  readonly role: "chairman" | "advisor"
  readonly gguf: string
  readonly alias: string
  readonly port: number
  readonly ctx: number
  /** CUDA_VISIBLE_DEVICES for this member; "" = all GPUs. */
  readonly gpus: string
  readonly extraArgs: readonly string[]
  readonly readyTimeoutSec: number
  /** Persona injected as the system prompt when this member advises. */
  readonly lens: string
  /** Completion cap when this member writes an advisor brief. */
  readonly briefMaxTokens: number
}

/**
 * Council lineup A. VRAM: chairman ~69 GB/GPU (Q4_K_M split 47,53) + gemma
 * ~24 GB on GPU0 + qwen ~22 GB on GPU1 ≈ 93/91 GB of 96 GB per card. Verified
 * co-resident.
 */
export const councilMembers: readonly CouncilMember[] = [
  {
    id: "minimax-m2.7",
    role: "chairman",
    gguf: path.join(ggufDir, "minimax-m2.7/MiniMax-M2.7-Q4_K_M-00001-of-00004.gguf"),
    alias: "minimax-m2.7",
    port: 9100,
    // 49152 OOMs GPU1 when cuBLAS lazily allocates its workspace at first
    // inference — 40960 is the proven ceiling alongside both advisors. The
    // runner caps synthesis completions so prompt + completion always fit.
    ctx: 40960,
    gpus: "",
    // lean on GPU1: the desktop and the larger advisor (gemma) both live on GPU0.
    // MINIMAX_EXTRA lets experiments add e.g. --reasoning-budget without a code change.
    extraArgs: ["-ts", "47,53", ...(process.env["MINIMAX_EXTRA"]?.split(" ") ?? [])],
    // cold load: 138GB from NVMe while both advisors also stream in
    readyTimeoutSec: 1800,
    // used when MiniMax advises a stronger chairman (council-vllm)
    lens:
      "You are the council's senior Architect. Propose the strongest overall structure for " +
      "the answer: the approach you would take, the key design decisions with one-line " +
      "rationale, and the trickiest details worth getting exactly right (spell those out " +
      "fully). Think briefly — do not deliberate at length. Your notes brief the model that " +
      "writes the final answer.",
    briefMaxTokens: 16384
  },
  {
    id: "gemma-4-31b",
    role: "advisor",
    gguf: path.join(ggufDir, "gemma-4-31b-qat/gemma-4-31B-it-QAT-Q4_0.gguf"),
    alias: "gemma-4-31b",
    port: 9101,
    ctx: 16384,
    gpus: "0",
    extraArgs: [],
    readyTimeoutSec: 300,
    lens:
      "You are the council's Skeptic. Attack the task before solving it: list the ways a " +
      "solution could be wrong, the edge cases and failure modes that matter most, and the " +
      "hardest test it must survive. Then sketch (do not fully write) the answer you would " +
      "accept. Be concrete and terse; your notes brief a stronger model that writes the final answer.",
    briefMaxTokens: 8192
  },
  {
    id: "qwen3.6-35b-a3b",
    role: "advisor",
    gguf: path.join(ggufDir, "qwen3.6-35b-a3b/Qwen3.6-35B-A3B-Q4_K_M.gguf"),
    alias: "qwen3.6-35b-a3b",
    port: 9102,
    ctx: 16384,
    gpus: "1",
    extraArgs: [],
    readyTimeoutSec: 300,
    lens:
      "You are the council's Architect. Propose the strongest overall structure for the " +
      "answer: the approach you would take, the key design decisions with one-line rationale, " +
      "and the trickiest details worth getting exactly right (spell those out fully). Be " +
      "concrete and terse; your notes brief a stronger model that writes the final answer.",
    briefMaxTokens: 8192
  }
]

/**
 * Members outside the default MiniMax council. Ornith fills both GPUs
 * (~83GB/GPU at IQ3_XXS) so it serves alone; QCN + Devstral 2 + gemma form
 * the fully-resident three-lab council (GPU0: QCN 46GB + gemma 18GB,
 * GPU1: Devstral 72GB).
 */
export const extraMembers: readonly CouncilMember[] = [
  {
    // production twin: packages/core/src/serve/council.ts (pi-engine use council)
    // serves this exact pair — keep launch args in sync
    id: "ornith-397b",
    role: "chairman",
    gguf: path.join(
      ggufDir,
      "ornith-1.0-397b/deepreinforce-ai_Ornith-1.0-397B-IQ3_XXS-00001-of-00005.gguf"
    ),
    alias: "ornith-397b",
    port: 9103,
    // solo on both GPUs there is KV headroom beyond 32k; ~11GB/GPU was still
    // idle at 49152, so 65536 fits. The baked reasoning budget is the proven
    // anti-spiral config (ornith-tuned, 305/400).
    ctx: 65536,
    gpus: "",
    extraArgs: [
      "-ts", "50,50",
      ...(process.env["ORNITH_EXTRA"]?.split(" ") ?? ["--reasoning-budget", "8192"])
    ],
    readyTimeoutSec: 1800,
    lens: "",
    briefMaxTokens: 8192
  },
  {
    id: "qwen3-coder-next",
    role: "chairman",
    gguf: path.join(ggufDir, "qwen3-coder-next/Qwen3-Coder-Next-UD-Q4_K_XL.gguf"),
    alias: "qwen3-coder-next",
    port: 9104,
    ctx: 40960,
    gpus: "0",
    extraArgs: [],
    readyTimeoutSec: 600,
    lens: "",
    briefMaxTokens: 8192
  },
  {
    // tiny scout: 2.3GB fits in Ornith's GPU1 margin — advisor AND checker
    id: "qwen3-4b",
    role: "advisor",
    gguf: path.join(ggufDir, "qwen3-4b/Qwen3-4B-Q4_K_M.gguf"),
    alias: "qwen3-4b",
    port: 9107,
    ctx: 16384,
    gpus: "1",
    extraArgs: [],
    readyTimeoutSec: 120,
    lens:
      "You are the council's Scout, a small fast model briefing a much stronger one. " +
      "Produce: (1) a checklist of every explicit requirement and constraint in the task, " +
      "quoted exactly; (2) the three hardest parts and why; (3) a terse plan of attack. " +
      "Do NOT write the answer itself.",
    briefMaxTokens: 4096
  },
  {
    // same weights as devstral-2-123b, split across both GPUs for chairman duty
    id: "devstral-2-chair",
    role: "chairman",
    gguf: path.join(
      ggufDir,
      "devstral-2-123b/Devstral-2-123B-Instruct-2512-Q4_K_M-00001-of-00002.gguf"
    ),
    alias: "devstral-2-chair",
    port: 9106,
    ctx: 40960,
    gpus: "",
    extraArgs: ["-ts", "50,50"],
    readyTimeoutSec: 900,
    lens: "",
    briefMaxTokens: 8192
  },
  {
    id: "devstral-2-123b",
    role: "advisor",
    gguf: path.join(
      ggufDir,
      "devstral-2-123b/Devstral-2-123B-Instruct-2512-Q4_K_M-00001-of-00002.gguf"
    ),
    alias: "devstral-2-123b",
    port: 9105,
    ctx: 16384,
    gpus: "1",
    extraArgs: [],
    readyTimeoutSec: 900,
    lens:
      "You are the council's senior Engineer. Propose the strongest overall structure for " +
      "the answer: the approach you would take, the key design decisions with one-line " +
      "rationale, and the trickiest details worth getting exactly right (spell those out " +
      "fully). Be concrete and terse; your notes brief the model that writes the final answer.",
    briefMaxTokens: 8192
  }
]

export const member = (id: string): CouncilMember => {
  const m = [...councilMembers, ...extraMembers].find((x) => x.id === id)
  if (m === undefined) throw new Error(`no council member ${id}`)
  return m
}

export const chairman = (): CouncilMember => {
  const c = councilMembers.find((m) => m.role === "chairman")
  if (c === undefined) throw new Error("council has no chairman")
  return c
}

export const advisors = (): readonly CouncilMember[] =>
  councilMembers.filter((m) => m.role === "advisor")

export const memberLogPath = (m: CouncilMember): string => `/tmp/pi-bench-${m.id}.log`

const spawnMember = (m: CouncilMember): Bun.Subprocess => {
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${paths.cudaBin}:${process.env["PATH"] ?? ""}`,
    LD_LIBRARY_PATH: `${paths.cudaLib}:${process.env["LD_LIBRARY_PATH"] ?? ""}`
  }
  // pinned only in the child env — never the manager's (see ds4 lesson)
  if (m.gpus !== "") env["CUDA_VISIBLE_DEVICES"] = m.gpus
  const log = Bun.file(memberLogPath(m))
  return Bun.spawn(
    [
      llamaBin,
      "-m", m.gguf,
      "--alias", m.alias,
      "--host", "127.0.0.1",
      "--port", String(m.port),
      "-ngl", "999",
      "-c", String(m.ctx),
      "--jinja",
      ...m.extraArgs
    ],
    { env, stdout: log, stderr: log }
  )
}

export interface CouncilHandle {
  readonly procs: readonly Bun.Subprocess[]
}

/** Start the given members and wait until all answer /health. Fails hard on timeout. */
export const startCouncil = (
  members: readonly CouncilMember[] = councilMembers
): Effect.Effect<CouncilHandle, Error> =>
  Effect.gen(function* () {
    yield* Console.log(`Starting council members: ${members.map((m) => m.id).join(", ")}…`)
    for (const m of members) {
      if (!fs.existsSync(m.gguf)) {
        return yield* Effect.fail(new Error(`member ${m.id} model missing: ${m.gguf}`))
      }
    }
    const procs = members.map(spawnMember)
    for (const m of members) {
      const ready = yield* health.waitHealthy(m.id, m.port, m.readyTimeoutSec)
      if (!ready) {
        for (const p of procs) p.kill("SIGTERM")
        const tail = (yield* Effect.promise(() =>
          Bun.file(memberLogPath(m)).text().catch(() => "")
        ))
          .split("\n")
          .slice(-15)
          .join("\n")
        return yield* Effect.fail(
          new Error(`council member ${m.id} not healthy on :${m.port}\nlast log lines:\n${tail}`)
        )
      }
      yield* Console.log(`  ✓ ${m.id} ready on :${m.port}`)
    }
    return { procs }
  })

export const stopCouncil = (handle: CouncilHandle): Effect.Effect<void> =>
  Effect.promise(async () => {
    for (const p of handle.procs) p.kill("SIGTERM")
    await Promise.all(handle.procs.map((p) => p.exited))
  })
