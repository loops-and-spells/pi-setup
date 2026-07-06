import * as fs from "node:fs"
import { paths } from "./paths"
import type { PiProvider } from "./pi-config"

export type EngineId = "llama" | "vllm" | "ds4" | "council"

export const engineIds: readonly EngineId[] = ["llama", "vllm", "ds4", "council"]

export interface EngineDef {
  readonly id: EngineId
  readonly title: string
  readonly port: number
  readonly unit: string
  readonly providerId: string
  readonly defaultModelId: string
  readonly readyTimeoutSec: number
  readonly experimental: boolean
  readonly provider: PiProvider
  /** Human-readable problems that must be fixed before this engine can start. */
  readonly preflight: () => string[]
}

const ds4Port = Number(process.env["DS4_PORT"] ?? 8082)
const ds4Ctx = Number(process.env["DS4_CTX"] ?? 100000)

export const engines: Record<EngineId, EngineDef> = {
  llama: {
    id: "llama",
    title: "llama.cpp (DeepSeek-V4-Flash)",
    port: 8080,
    unit: "llama-v4.service",
    providerId: "deepseek-v4",
    defaultModelId: "deepseek-v4-flash",
    readyTimeoutSec: 600,
    experimental: false,
    provider: {
      name: "DeepSeek V4 (llama-server, CUDA fork)",
      baseUrl: "http://localhost:8080/v1",
      api: "openai-completions",
      apiKey: "llamacpp",
      compat: { supportsDeveloperRole: false },
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek-V4-Flash 284B MXFP4 (llama-server, dual-GPU)",
          contextWindow: 262144,
          maxTokens: 65536
        }
      ]
    },
    preflight: () => {
      const problems: string[] = []
      if (!fs.existsSync(paths.llama.bin)) {
        problems.push(`llama-server binary missing: ${paths.llama.bin}`)
      }
      if (!fs.existsSync(paths.llama.ggufDir)) {
        problems.push(`GGUF dir missing: ${paths.llama.ggufDir}`)
      }
      return problems
    }
  },

  vllm: {
    id: "vllm",
    title: "vLLM + DSpark (DeepSeek-V4-Flash-DSpark)",
    port: 8081,
    unit: "vllm-dspark.service",
    providerId: "deepseek-v4-dspark",
    defaultModelId: "deepseek-v4-flash-dspark",
    readyTimeoutSec: 1800,
    experimental: false,
    provider: {
      name: "DeepSeek V4 + DSpark (vLLM, Docker)",
      baseUrl: "http://localhost:8081/v1",
      api: "openai-completions",
      apiKey: "EMPTY",
      compat: { supportsDeveloperRole: false },
      models: [
        {
          id: "deepseek-v4-flash-dspark",
          name: "DeepSeek-V4-Flash-DSpark 284B (vLLM, DSpark spec-dec)",
          // matches MAX_MODEL_LEN: KV for 262144 does not fit at TP=2 fp8
          contextWindow: 131072,
          // paged KV: long outputs cost nothing until generated
          maxTokens: 65536
        }
      ]
    },
    preflight: () => {
      const problems: string[] = []
      if (!fs.existsSync(`${paths.vllm.modelDir}/config.json`)) {
        problems.push(
          `model missing: ${paths.vllm.modelDir} — ` +
            `hf download deepseek-ai/DeepSeek-V4-Flash-DSpark --local-dir ${paths.vllm.modelDir}`
        )
      }
      return problems
    }
  },

  ds4: {
    id: "ds4",
    title: "DwarfStar ds4 (DeepSeek-V4-Flash GGUF)",
    port: ds4Port,
    unit: "ds4.service",
    providerId: "deepseek-v4-ds4",
    defaultModelId: "deepseek-v4-flash",
    readyTimeoutSec: 900,
    experimental: false,
    provider: {
      name: "DeepSeek V4 (DwarfStar ds4, CUDA)",
      baseUrl: `http://localhost:${ds4Port}/v1`,
      api: "openai-completions",
      apiKey: "EMPTY",
      compat: { supportsDeveloperRole: false },
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek-V4-Flash imatrix GGUF (ds4, CUDA)",
          contextWindow: ds4Ctx,
          maxTokens: 32768
        }
      ]
    },
    preflight: () => {
      const problems: string[] = []
      const server = `${paths.ds4.dir}/ds4-server`
      if (!fs.existsSync(server)) {
        problems.push(`ds4-server not built: ${server} — run: pi-engine setup ds4`)
      }
      if (!fs.existsSync(paths.ds4.model)) {
        problems.push(`ds4 model missing: ${paths.ds4.model} — run: pi-engine setup ds4`)
      }
      return problems
    }
  },

  council: {
    id: "council",
    title: "ornith-council (Ornith-397B + Qwen3-4B scout)",
    port: 9110,
    unit: "ornith-council.service",
    providerId: "ornith-council",
    defaultModelId: "ornith-council",
    readyTimeoutSec: 1800,
    experimental: false,
    provider: {
      name: "Ornith Council (Ornith-397B chairman + Qwen3-4B scout, llama.cpp)",
      baseUrl: "http://localhost:9110/v1",
      api: "openai-completions",
      apiKey: "EMPTY",
      compat: { supportsDeveloperRole: false },
      models: [
        {
          id: "ornith-council",
          name: "ornith-council — scout brief → Ornith → check → revise (bench 284/300)",
          contextWindow: 65536,
          maxTokens: 49152
        },
        {
          id: "ornith-397b",
          name: "Ornith-397B IQ3 passthrough (no council overhead)",
          contextWindow: 65536,
          maxTokens: 49152
        }
      ]
    },
    preflight: () => {
      const problems: string[] = []
      if (!fs.existsSync(paths.llama.bin)) {
        problems.push(`llama-server binary missing: ${paths.llama.bin}`)
      }
      if (!fs.existsSync(paths.council.ornithGguf)) {
        problems.push(`Ornith model missing: ${paths.council.ornithGguf}`)
      }
      if (!fs.existsSync(paths.council.scoutGguf)) {
        problems.push(`scout model missing: ${paths.council.scoutGguf}`)
      }
      return problems
    }
  }
}
