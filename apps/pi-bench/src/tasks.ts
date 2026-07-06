import * as fs from "node:fs"
import * as path from "node:path"
import type { BenchTask } from "./types"

const tasksDir = path.resolve(import.meta.dir, "../tasks")

export const loadTasks = (only?: readonly string[]): readonly BenchTask[] => {
  const all = fs
    .readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8")) as BenchTask)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (only === undefined || only.length === 0) return all
  const missing = only.filter((id) => !all.some((t) => t.id === id))
  if (missing.length > 0) throw new Error(`unknown task ids: ${missing.join(", ")}`)
  return all.filter((t) => only.includes(t.id))
}
