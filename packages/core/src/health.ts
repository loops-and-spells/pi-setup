import { Console, Effect } from "effect"

const probe = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

/** True when either /health or /v1/models answers 2xx on the port. */
export const isHealthy = (port: number): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    if (await probe(`http://127.0.0.1:${port}/health`)) return true
    return probe(`http://127.0.0.1:${port}/v1/models`)
  })

/** Poll until healthy, logging progress. Resolves false on timeout. */
export const waitHealthy = (
  name: string,
  port: number,
  timeoutSec: number
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const started = Date.now()
    let lastLog = 0
    while (Date.now() - started < timeoutSec * 1000) {
      if (yield* isHealthy(port)) return true
      const elapsed = Math.round((Date.now() - started) / 1000)
      if (elapsed - lastLog >= 30) {
        lastLog = elapsed
        yield* Console.log(`  … waiting for ${name} on :${port} (${elapsed}s / ${timeoutSec}s)`)
      }
      yield* Effect.sleep("5 seconds")
    }
    return false
  })

/** Model ids reported by the OpenAI-compatible endpoint, or [] on failure. */
export const listModels = (port: number): Effect.Effect<readonly string[]> =>
  Effect.promise(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) return []
      const body = (await res.json()) as { data?: Array<{ id?: string }> }
      return (body.data ?? []).map((m) => m.id ?? "?")
    } catch {
      return []
    }
  })
