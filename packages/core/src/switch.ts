import { Console, Data, Effect } from "effect"
import * as docker from "./docker"
import { engineIds, engines, type EngineId } from "./engines"
import * as gpu from "./gpu"
import * as health from "./health"
import * as lmstudio from "./lmstudio"
import { paths } from "./paths"
import * as pi from "./pi-config"
import * as systemd from "./systemd"

export class SwitchError extends Data.TaggedError("SwitchError")<{
  readonly reason: string
}> {
  override get message(): string {
    return this.reason
  }
}

/** Stop every engine (and optionally LM Studio) so VRAM is actually released. */
export const stopAll = (opts: { includeLmStudio: boolean; except?: EngineId }) =>
  Effect.gen(function* () {
    if (opts.includeLmStudio) yield* lmstudio.shutdown()
    for (const id of engineIds) {
      if (id === opts.except) continue
      const eng = engines[id]
      if (yield* systemd.isActive(eng.unit)) {
        yield* Console.log(`Stopping ${eng.unit}…`)
        yield* systemd.stop(eng.unit)
      }
      yield* systemd.resetFailed(eng.unit)
    }
    if (opts.except !== "vllm") {
      // the container can outlive its unit (docker run detaches from the cgroup)
      yield* docker.removeContainer(paths.vllm.container)
    }
  })

const pointPiAt = (id: EngineId) =>
  Effect.gen(function* () {
    const eng = engines[id]
    yield* pi.ensureProvider(eng.providerId, eng.provider)
    yield* pi.setDefault(eng.providerId, eng.defaultModelId)
  })

/**
 * The full stack switch the old switch-engine only did halfway:
 * preflight → stop everything else (incl. LM Studio) → wait for VRAM →
 * systemd start → health gate → pi provider/model update → verify /v1/models.
 */
export const switchTo = (id: EngineId): Effect.Effect<void, SwitchError> =>
  Effect.gen(function* () {
    const eng = engines[id]
    yield* Console.log(`Switching to ${eng.title} — port ${eng.port}, unit ${eng.unit}`)
    if (eng.experimental) {
      yield* Console.log("  ⚠ this engine is marked experimental")
    }

    const problems = eng.preflight()
    if (problems.length > 0) {
      for (const p of problems) yield* Console.error(`  ✗ ${p}`)
      return yield* new SwitchError({ reason: `${eng.id} failed preflight checks` })
    }

    if (!systemd.unitInstalled(eng.unit)) {
      return yield* new SwitchError({
        reason: `${eng.unit} is not installed — run: pi-engine install`
      })
    }

    // Already up? Just make sure pi points at it.
    if ((yield* systemd.isActive(eng.unit)) && (yield* health.isHealthy(eng.port))) {
      yield* Console.log(`${eng.title} already running and healthy.`)
      yield* pointPiAt(id)
      return
    }

    yield* stopAll({ includeLmStudio: true, except: id })

    yield* Console.log("Waiting for VRAM to be released…")
    yield* gpu.waitVramFree()

    yield* Console.log(`Starting ${eng.unit}…`)
    yield* systemd
      .start(eng.unit)
      .pipe(
        Effect.mapError((e) => new SwitchError({ reason: `systemctl start failed: ${e.message}` }))
      )

    const ready = yield* health.waitHealthy(eng.title, eng.port, eng.readyTimeoutSec)
    if (!ready) {
      const tail = yield* systemd.journalTail(eng.unit, 25)
      yield* Console.error(`\nLast journal lines for ${eng.unit}:\n${tail}`)
      return yield* new SwitchError({
        reason: `${eng.title} did not become healthy within ${eng.readyTimeoutSec}s`
      })
    }

    yield* pointPiAt(id)

    const models = yield* health.listModels(eng.port)
    yield* Console.log(`\n✅ ${eng.title} is ready on :${eng.port}`)
    if (models.length > 0) yield* Console.log(`   serving: ${models.join(", ")}`)
    yield* Console.log("   Restart pi (or start a new session) to pick up the change.")
  })
