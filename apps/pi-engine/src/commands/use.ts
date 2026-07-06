import { Command } from "@effect/cli"
import { switchTo } from "@pi-setup/core"
import { engineArg } from "../args"

export const useCommand = Command.make("use", { engine: engineArg }, ({ engine }) =>
  switchTo(engine)
).pipe(
  Command.withDescription(
    "Stop the other engines (and LM Studio), start the chosen one, wait for health, and point pi at it"
  )
)
