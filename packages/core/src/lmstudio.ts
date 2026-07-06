import * as fs from "node:fs"
import { Console, Effect } from "effect"
import { paths } from "./paths"
import { run } from "./shell"
import * as systemd from "./systemd"

/**
 * Fully release LM Studio's VRAM: `lms daemon down` unloads every model and
 * stops its server, and stopping the user unit keeps systemd from reviving it.
 * The old switch-engine skipped this when starting llama via nohup — that is
 * why the "complete stack" never came up: LM Studio kept ~50GB of VRAM.
 */
export const shutdown = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    const lmsActive = yield* systemd.isActive("lmstudio.service")
    if (lmsActive) {
      yield* Console.log("Stopping lmstudio.service…")
      yield* systemd.stop("lmstudio.service")
    }
    if (fs.existsSync(paths.lms)) {
      yield* run([paths.lms, "daemon", "down"]) // idempotent, ignore failures
    }
  })

export const isActive = (): Effect.Effect<boolean> => systemd.isActive("lmstudio.service")
