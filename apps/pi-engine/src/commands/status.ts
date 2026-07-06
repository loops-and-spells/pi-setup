import { Command } from "@effect/cli"
import {
  docker,
  engineIds,
  engines,
  gpu,
  health,
  lmstudio,
  paths,
  pi,
  systemd
} from "@pi-setup/core"
import { Console, Effect } from "effect"

export const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    yield* Console.log("Inference Engine Status")
    yield* Console.log("========================\n")

    const current = yield* pi.currentDefault()
    yield* Console.log(`pi default: ${current.provider} / ${current.model}\n`)

    for (const id of engineIds) {
      const eng = engines[id]
      const active = yield* systemd.isActive(eng.unit)
      const healthy = yield* health.isHealthy(eng.port)
      const installed = systemd.unitInstalled(eng.unit)
      const isCurrent = current.provider === eng.providerId
      const state = healthy
        ? "✅ RUNNING"
        : active
          ? "🟡 starting (unit active, not healthy yet)"
          : installed
            ? "⬜ stopped"
            : "✗ unit not installed"
      const marks = [isCurrent ? "← pi" : "", eng.experimental ? "(experimental)" : ""]
        .filter((s) => s.length > 0)
        .join(" ")
      yield* Console.log(`  ${state}  ${id.padEnd(6)} :${eng.port}  ${eng.title} ${marks}`)
    }

    if (systemd.unitInstalled("lmstudio.service")) {
      const lmsActive = yield* lmstudio.isActive()
      yield* Console.log(`\n  ${lmsActive ? "🟡 active" : "⬜ stopped"}  lmstudio.service`)
    } else {
      yield* Console.log("")
    }
    const containerUp = yield* docker.containerRunning(paths.vllm.container)
    yield* Console.log(`  ${containerUp ? "🟡 running" : "⬜ absent "}  docker:${paths.vllm.container}`)

    const gpus = yield* gpu.query()
    if (gpus.length > 0) {
      yield* Console.log("")
      for (const g of gpus) {
        yield* Console.log(
          `  GPU${g.index} ${g.name}: ${g.usedMiB}/${g.totalMiB} MiB, ${g.utilPct}% util`
        )
      }
    }
  })
).pipe(Command.withDescription("Show engine, LM Studio, pi-config, and GPU state"))
