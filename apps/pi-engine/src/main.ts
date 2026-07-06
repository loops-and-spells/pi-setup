import { Command } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"
import { doctorCommand } from "./commands/doctor"
import { installCommand } from "./commands/install"
import { logsCommand } from "./commands/logs"
import { probeCommand } from "./commands/probe"
import { serveCommand } from "./commands/serve"
import { setupCommand } from "./commands/setup"
import { statusCommand } from "./commands/status"
import { stopCommand } from "./commands/stop"
import { useCommand } from "./commands/use"

const root = Command.make("pi-engine").pipe(
  Command.withDescription(
    "Local inference enablement suite: toggle llama.cpp / vLLM+DSpark / DwarfStar ds4 " +
      "for the pi harness on the dual-Blackwell workstation"
  ),
  Command.withSubcommands([
    useCommand,
    statusCommand,
    stopCommand,
    logsCommand,
    serveCommand,
    setupCommand,
    probeCommand,
    installCommand,
    doctorCommand
  ])
)

const cli = Command.run(root, {
  name: "pi-engine",
  version: "0.2.0"
})

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
