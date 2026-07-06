import { Effect } from "effect"
import { run, runOk } from "./shell"

export const removeContainer = (name: string): Effect.Effect<void> =>
  run(["docker", "rm", "-f", name]).pipe(Effect.asVoid)

export const containerRunning = (name: string): Effect.Effect<boolean> =>
  run(["docker", "ps", "--format", "{{.Names}}"]).pipe(
    Effect.map((r) => r.stdout.split("\n").includes(name))
  )

export const imageExists = (image: string): Effect.Effect<boolean> =>
  run(["docker", "image", "inspect", image]).pipe(Effect.map((r) => r.code === 0))

export const pull = (image: string) => runOk(["docker", "pull", image])
