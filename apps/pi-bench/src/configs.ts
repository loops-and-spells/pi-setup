import type { EngineId } from "@pi-setup/core"

export type BenchConfigId =
  | "council"
  | "council-v2"
  | "council-vllm"
  | "chairman-solo"
  | "ornith-solo"
  | "qcn-solo"
  | "qcn-council"
  | "gemma-solo"
  | "devstral-solo"
  | "qwen36-solo"
  | "devstral-council"
  | "ornith-council"
  | "council-v3"
  | "llama-v4"
  | "vllm-dspark"
  | "vllm-single"
  | "vllm-bo3"
  | "vllm-verify"
  | "vllm-greedy"
  | "vllm-ctx-none"
  | "vllm-ctx-map"
  | "vllm-ctx-full"
  | "taste-off"
  | "taste-on"
  | "plan-exec"
  | "crit-revise"

export interface EngineBenchConfig {
  readonly kind: "engine"
  readonly id: BenchConfigId
  readonly engine: EngineId
  readonly port: number
  readonly model: string
}

export interface CouncilBenchConfig {
  readonly kind:
    | "council"
    | "council-v2"
    | "council-vllm"
    | "chairman-solo"
    | "ornith-solo"
    | "qcn-solo"
    | "qcn-council"
    | "gemma-solo"
    | "devstral-solo"
    | "qwen36-solo"
    | "devstral-council"
    | "ornith-council"
    | "council-v3"
  readonly id: BenchConfigId
}

/**
 * Harness techniques, all A/B'd on one endpoint — the vLLM engine by default,
 * or any already-serving model via TECHNIQUE_PORT / TECHNIQUE_MODEL env
 * (used to measure technique lift on small models, where headroom lives).
 * `single` = single shot at task temperature: the baseline under an override,
 * where the vllm-dspark engine config can't follow.
 */
export type TechniqueId =
  | "single"
  | "bo3"
  | "verify"
  | "greedy"
  | "ctx-none"
  | "ctx-map"
  | "ctx-full"
  | "taste-off"
  | "taste-on"
  | "plan-exec"
  | "crit-revise"

export interface TechniqueBenchConfig {
  readonly kind: "technique"
  readonly id: BenchConfigId
  readonly technique: TechniqueId
}

export type BenchConfig = EngineBenchConfig | CouncilBenchConfig | TechniqueBenchConfig

export const vllmEngineConfig: EngineBenchConfig = {
  kind: "engine",
  id: "vllm-dspark",
  engine: "vllm",
  port: 8081,
  model: "deepseek-v4-flash-dspark"
}

/**
 * Run order minimizes model (re)loads: every config that needs the council
 * servers shares one serving session (council-vllm only collects its advisor
 * briefs there), and vllm goes last so the box ends up on pi's default engine —
 * council-vllm's synthesis phase rides that same vllm session.
 */
export const benchConfigs: readonly BenchConfig[] = [
  { kind: "chairman-solo", id: "chairman-solo" },
  { kind: "council", id: "council" },
  { kind: "council-v2", id: "council-v2" },
  { kind: "council-vllm", id: "council-vllm" },
  { kind: "ornith-solo", id: "ornith-solo" },
  { kind: "qcn-solo", id: "qcn-solo" },
  { kind: "qcn-council", id: "qcn-council" },
  { kind: "gemma-solo", id: "gemma-solo" },
  { kind: "devstral-solo", id: "devstral-solo" },
  { kind: "qwen36-solo", id: "qwen36-solo" },
  { kind: "devstral-council", id: "devstral-council" },
  { kind: "ornith-council", id: "ornith-council" },
  // ornith-council + the production proxy's resample ladder (draft-checks)
  { kind: "council-v3", id: "council-v3" },
  { kind: "engine", id: "llama-v4", engine: "llama", port: 8080, model: "deepseek-v4-flash" },
  vllmEngineConfig,
  // technique configs ride the vllm session started for vllm-dspark above;
  // vllm-dspark itself is their single-shot baseline
  { kind: "technique", id: "vllm-single", technique: "single" },
  { kind: "technique", id: "vllm-greedy", technique: "greedy" },
  { kind: "technique", id: "vllm-bo3", technique: "bo3" },
  { kind: "technique", id: "vllm-verify", technique: "verify" },
  { kind: "technique", id: "vllm-ctx-none", technique: "ctx-none" },
  { kind: "technique", id: "vllm-ctx-map", technique: "ctx-map" },
  { kind: "technique", id: "vllm-ctx-full", technique: "ctx-full" },
  // taste A/B: identical single shots, ± the learned-preferences system block
  { kind: "technique", id: "taste-off", technique: "taste-off" },
  { kind: "technique", id: "taste-on", technique: "taste-on" },
  // delegation study: role-composition patterns (plan→execute, draft→critique→revise)
  { kind: "technique", id: "plan-exec", technique: "plan-exec" },
  { kind: "technique", id: "crit-revise", technique: "crit-revise" }
]

export const configIds: readonly BenchConfigId[] = benchConfigs.map((c) => c.id)
