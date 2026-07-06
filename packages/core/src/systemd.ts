import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { paths } from "./paths"
import { run, runOk } from "./shell"

export const isActive = (unit: string): Effect.Effect<boolean> =>
  run(["systemctl", "--user", "is-active", unit]).pipe(
    Effect.map((r) => r.stdout.trim() === "active")
  )

export const start = (unit: string) => runOk(["systemctl", "--user", "start", unit])

export const stop = (unit: string): Effect.Effect<void> =>
  run(["systemctl", "--user", "stop", unit]).pipe(Effect.asVoid)

export const resetFailed = (unit: string): Effect.Effect<void> =>
  run(["systemctl", "--user", "reset-failed", unit]).pipe(Effect.asVoid)

export const daemonReload = () => runOk(["systemctl", "--user", "daemon-reload"])

export const unitPath = (unit: string): string => path.join(paths.systemdUserDir, unit)

export const unitInstalled = (unit: string): boolean => fs.existsSync(unitPath(unit))

export const unitContent = (unit: string): string | null => {
  const p = unitPath(unit)
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null
}

export const journalTail = (unit: string, lines = 25): Effect.Effect<string> =>
  run(["journalctl", "--user", "-u", unit, "-n", String(lines), "--no-pager", "-o", "cat"]).pipe(
    Effect.map((r) => r.stdout.trim())
  )
