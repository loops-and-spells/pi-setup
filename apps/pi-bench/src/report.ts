import * as fs from "node:fs"
import * as path from "node:path"
import type { BenchTask, RunManifest, TaskResult } from "./types"

/** Deterministic per-task shuffle so the judge pack is blind but reproducible. */
const mulberry32 = (seed: number) => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const hash = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const shuffled = <T>(items: readonly T[], seed: string): T[] => {
  const rand = mulberry32(hash(seed))
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

const secs = (ms: number): string => `${Math.round(ms / 100) / 10}s`

export const writeReports = (
  outDir: string,
  manifest: RunManifest,
  tasks: readonly BenchTask[]
): void => {
  fs.mkdirSync(path.join(outDir, "raw"), { recursive: true })
  fs.writeFileSync(path.join(outDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  for (const r of manifest.results) {
    const dir = path.join(outDir, "raw", r.configId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${r.taskId}.json`), `${JSON.stringify(r, null, 2)}\n`)
  }

  // metrics.md — identified; kept out of the judge pack so speed can't bias quality
  const lines: string[] = ["# Benchmark metrics", "", `Run: ${manifest.runId}`, ""]
  for (const task of tasks) {
    lines.push(`## ${task.id}`, "", "| config | wall | completion tok | stages |", "|---|---|---|---|")
    for (const r of manifest.results.filter((x) => x.taskId === task.id)) {
      const stages = r.stages
        .map((s) => `${s.stage} ${secs(s.metrics.wallMs)} @${s.metrics.tokensPerSec} t/s`)
        .join("<br>")
      lines.push(
        r.error !== undefined
          ? `| ${r.configId} | ERROR | — | ${r.error} |`
          : `| ${r.configId} | ${secs(r.wallMs)} | ${r.completionTokens} | ${stages} |`
      )
    }
    lines.push("")
  }
  fs.writeFileSync(path.join(outDir, "metrics.md"), `${lines.join("\n")}\n`)

  // judge-pack.md — outputs only, anonymized per task; mapping.json unblinds
  const mapping: Record<string, Record<string, string>> = {}
  const pack: string[] = [
    "# Judge pack",
    "",
    "Responses are anonymized and shuffled per task. Score against each task's",
    "rubric before reading mapping.json.",
    ""
  ]
  for (const task of tasks) {
    const results = manifest.results.filter((x) => x.taskId === task.id)
    const order = shuffled(results, `${manifest.runId}:${task.id}`)
    pack.push(`## Task: ${task.id} — ${task.title}`, "", "### Prompt", "", task.prompt, "")
    pack.push("### Judge rubric", "", task.judgeNotes, "")
    mapping[task.id] = {}
    order.forEach((r, i) => {
      const label = String.fromCharCode(65 + i)
      mapping[task.id]![label] = r.configId
      pack.push(`### Response ${label}`, "")
      pack.push(r.error !== undefined ? `*(failed: ${r.error})*` : r.output, "")
    })
  }
  fs.writeFileSync(path.join(outDir, "judge-pack.md"), `${pack.join("\n")}\n`)
  fs.writeFileSync(path.join(outDir, "mapping.json"), `${JSON.stringify(mapping, null, 2)}\n`)
}
