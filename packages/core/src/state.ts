import * as fs from "node:fs"
import * as path from "node:path"
import { paths } from "./paths"

export interface SuiteState {
  /** Result of the last `pi-engine probe p2p` run (undefined = never probed). */
  p2pWorks?: boolean
  p2pTestedAt?: string
}

const stateFile = path.join(
  process.env["XDG_STATE_HOME"] ?? path.join(paths.home, ".local/state"),
  "pi-engine/state.json"
)

export const readState = (): SuiteState => {
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as SuiteState
  } catch {
    return {}
  }
}

export const writeState = (patch: Partial<SuiteState>): SuiteState => {
  const next = { ...readState(), ...patch }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export const statePath = (): string => stateFile
