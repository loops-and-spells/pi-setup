import { Command } from "@effect/cli"
import { install } from "@pi-setup/core"

export const installCommand = Command.make("install", {}, () => install()).pipe(
  Command.withDescription(
    "Write the systemd user units (with backups), the pi-engine/switch-engine shims, and register pi providers"
  )
)
