import * as fs from "node:fs"
import * as path from "node:path"
import type { BenchTask } from "./types"

const tasksDir = path.resolve(import.meta.dir, "../tasks")

export const renderFiles = (files: Readonly<Record<string, string>>): string =>
  Object.entries(files)
    .map(([rel, content]) => `### \`${rel}\`\n\`\`\`python\n${content}\n\`\`\``)
    .join("\n\n")

/**
 * Task JSON for repoContext tasks carries the prompt WITHOUT the files; the
 * default prompt every non-ctx config sees embeds all files verbatim (the
 * fairest self-contained baseline). ctx-* technique configs re-render from
 * rawPrompt.
 */
const withContext = (task: BenchTask): BenchTask => {
  if (task.repoContext === undefined) return task
  return {
    ...task,
    rawPrompt: task.prompt,
    prompt: `${task.prompt}\n\n## Project files\n\n${renderFiles(task.repoContext.files)}`
  }
}

export const loadTasks = (only?: readonly string[]): readonly BenchTask[] => {
  const all = fs
    .readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => withContext(JSON.parse(fs.readFileSync(path.join(tasksDir, f), "utf8")) as BenchTask))
    .sort((a, b) => a.id.localeCompare(b.id))
  if (only === undefined || only.length === 0) return all
  const missing = only.filter((id) => !all.some((t) => t.id === id))
  if (missing.length > 0) throw new Error(`unknown task ids: ${missing.join(", ")}`)
  return all.filter((t) => only.includes(t.id))
}
