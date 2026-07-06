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
  | "llama-v4"
  | "vllm-dspark"

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
  readonly id: BenchConfigId
}

export type BenchConfig = EngineBenchConfig | CouncilBenchConfig

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
  { kind: "engine", id: "llama-v4", engine: "llama", port: 8080, model: "deepseek-v4-flash" },
  vllmEngineConfig
]

export const configIds: readonly BenchConfigId[] = benchConfigs.map((c) => c.id)
