import { Command, Options } from "@effect/cli"
import { gpu, stopAll } from "@pi-setup/core"
import { Console, Effect } from "effect"

const lmStudioFlag = Options.boolean("lmstudio").pipe(
  Options.withDescription("Also stop LM Studio (lms daemon down + unit)")
)

export const stopCommand = Command.make("stop", { lmstudio: lmStudioFlag }, ({ lmstudio }) =>
  Effect.gen(function* () {
    yield* stopAll({ includeLmStudio: lmstudio })
    yield* Effect.sleep("3 seconds")
    const gpus = yield* gpu.query()
    for (const g of gpus) {
      yield* Console.log(`GPU${g.index}: ${g.usedMiB} MiB still allocated`)
    }
    yield* Console.log("✅ all engines stopped")
  })
).pipe(Command.withDescription("Stop every inference engine (add --lmstudio to stop that too)"))
