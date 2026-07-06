import { Console, Effect } from "effect"
import { run } from "./shell"

export interface GpuInfo {
  readonly index: number
  readonly name: string
  readonly totalMiB: number
  readonly usedMiB: number
  readonly utilPct: number
}

export const query = (): Effect.Effect<readonly GpuInfo[]> =>
  run([
    "nvidia-smi",
    "--query-gpu=index,name,memory.total,memory.used,utilization.gpu",
    "--format=csv,noheader,nounits"
  ]).pipe(
    Effect.map((r) => {
      if (r.code !== 0) return []
      return r.stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [index, name, total, used, util] = line.split(",").map((s) => s.trim())
          return {
            index: Number(index ?? -1),
            name: name ?? "unknown",
            totalMiB: Number(total ?? 0),
            usedMiB: Number(used ?? 0),
            utilPct: Number(util ?? 0)
          }
        })
    })
  )

/**
 * Wait until every GPU is below `thresholdMiB` of used VRAM — i.e. the
 * previous engine has actually released its memory. Resolves false on
 * timeout (callers should warn, not abort: the desktop keeps some VRAM).
 */
export const waitVramFree = (
  thresholdMiB = 6144,
  timeoutSec = 120
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const started = Date.now()
    while (Date.now() - started < timeoutSec * 1000) {
      const gpus = yield* query()
      if (gpus.length === 0) return true // no nvidia-smi — nothing to wait for
      if (gpus.every((g) => g.usedMiB < thresholdMiB)) return true
      yield* Effect.sleep("3 seconds")
    }
    const gpus = yield* query()
    yield* Console.log(
      `  ⚠ VRAM still in use after ${timeoutSec}s: ` +
        gpus.map((g) => `GPU${g.index} ${g.usedMiB}MiB`).join(", ")
    )
    return false
  })
