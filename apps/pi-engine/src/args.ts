import { Args } from "@effect/cli"
import type { EngineId } from "@pi-setup/core"

export const engineArg = Args.choice<EngineId>(
  [
    ["llama", "llama"],
    ["vllm", "vllm"],
    ["ds4", "ds4"],
    ["council", "council"]
  ],
  { name: "engine" }
).pipe(
  Args.withDescription(
    "Inference engine: llama (llama.cpp), vllm (vLLM+DSpark), ds4 (DwarfStar), council (Ornith+scout)"
  )
)
