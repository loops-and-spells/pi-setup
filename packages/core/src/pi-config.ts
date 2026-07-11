import * as fs from "node:fs"
import { Console, Effect } from "effect"
import { paths } from "./paths"

export interface PiModelEntry {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
}

export interface PiProvider {
  readonly name: string
  readonly baseUrl: string
  readonly api: string
  readonly apiKey: string
  readonly compat?: Record<string, unknown>
  readonly models: readonly PiModelEntry[]
}

interface PiModelsFile {
  providers: Record<string, PiProvider>
}

interface PiSettingsFile {
  defaultProvider?: string
  defaultModel?: string
  [key: string]: unknown
}

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T

const writeJson = (file: string, value: unknown): void => {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Reconcile the provider entry in ~/.pi/agent/models.json with the repo
 * definition. Adds it when missing and rewrites it when it differs —
 * models.json is generated, never hand-edited, so any drift on a
 * repo-managed provider is staleness, not user intent. (An add-only merge
 * once left pi believing ornith-council had a 65k window against a 262k
 * server: constant compaction + 1-token completions at the false boundary.)
 */
export const ensureProvider = (id: string, provider: PiProvider): Effect.Effect<void> =>
  Effect.gen(function* () {
    const models = readJson<PiModelsFile>(paths.pi.models)
    const current = models.providers[id]
    if (current !== undefined && JSON.stringify(current) === JSON.stringify(provider)) return
    models.providers[id] = provider
    writeJson(paths.pi.models, models)
    yield* Console.log(
      `${current === undefined ? "Added" : "Updated"} provider "${id}" in ${paths.pi.models}`
    )
  })

/** Point pi at a provider/model pair (what switch-engine's python inline did). */
export const setDefault = (provider: string, model: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    const settings = readJson<PiSettingsFile>(paths.pi.settings)
    settings.defaultProvider = provider
    settings.defaultModel = model
    writeJson(paths.pi.settings, settings)
    yield* Console.log(`✅ pi default set to ${provider} / ${model}`)
  })

export const currentDefault = (): Effect.Effect<{ provider: string; model: string }> =>
  Effect.sync(() => {
    try {
      const settings = readJson<PiSettingsFile>(paths.pi.settings)
      return {
        provider: settings.defaultProvider ?? "unknown",
        model: settings.defaultModel ?? "unknown"
      }
    } catch {
      return { provider: "unreadable", model: "unreadable" }
    }
  })
