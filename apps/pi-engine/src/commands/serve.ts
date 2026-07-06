import { Command } from "@effect/cli"
import { serveCouncil, serveDs4, serveLlama, serveVllm } from "@pi-setup/core"
import { Effect } from "effect"
import { engineArg } from "../args"

/**
 * Foreground runner used as ExecStart by the systemd units. Runs until the
 * engine exits; a non-zero engine exit fails the Effect so Restart=on-failure
 * kicks in.
 */
export const serveCommand = Command.make("serve", { engine: engineArg }, ({ engine }) =>
  Effect.gen(function* () {
    const code = yield* engine === "llama"
      ? serveLlama()
      : engine === "vllm"
        ? serveVllm()
        : engine === "council"
          ? serveCouncil()
          : serveDs4()
    if (code !== 0) {
      return yield* Effect.fail(new Error(`${engine} exited with code ${code}`))
    }
  })
).pipe(Command.withDescription("Run an engine in the foreground (used by the systemd units)"))
