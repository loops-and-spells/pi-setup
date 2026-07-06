/**
 * Isolated repair loop: take an existing glyph deliverable, show the chairman
 * real execution failures, and see if it can fix its own language.
 * Usage: bun run src/repair-experiment.ts <result.json> <port> <alias> [rounds]
 * Assumes the model is already serving on <port>.
 */
import * as fs from "node:fs"
import { chat } from "./client"
import { execViolations, revisionPrompt } from "./runner"
import { loadTasks } from "./tasks"

const [, , resultPath, portStr, alias, roundsStr] = process.argv
if (resultPath === undefined || portStr === undefined || alias === undefined) {
  console.error("usage: repair-experiment.ts <result.json> <port> <alias> [rounds]")
  process.exit(1)
}
const task = loadTasks(["glyph-esolang"])[0]
if (task === undefined) throw new Error("glyph task missing")

let current = (JSON.parse(fs.readFileSync(resultPath, "utf8")) as { output: string }).output
const rounds = Number(roundsStr ?? 3)

for (let round = 1; round <= rounds; round++) {
  const violations = execViolations(current)
  console.log(`\n=== round ${round}: ${violations.length} violation(s)`)
  for (const v of violations) console.log(`  - ${v.split("\n")[0]}`)
  if (violations.length === 0) {
    console.log("ALL EXAMPLES PASS — language is functional")
    break
  }
  const numbered =
    violations.map((v, i) => `${i + 1}. ${v}`).join("\n") +
    "\n\nStructure the corrected answer as: spec, then ONE fenced block with the full " +
    "interpreter, then an '## Example Programs' section containing exactly three examples — " +
    "each as one fenced block with the program and one fenced block with its exact expected " +
    "output. No other fenced code blocks anywhere."
  console.log("  revising…")
  const started = Date.now()
  const r = await chat({
    port: Number(portStr),
    model: alias,
    messages: [{ role: "user", content: revisionPrompt(task, current, numbered) }],
    temperature: task.temperature,
    maxTokens: 24576,
    timeoutMs: 25 * 60 * 1000
  })
  console.log(
    `  revision: ${r.metrics.completionTokens} tok in ${Math.round((Date.now() - started) / 1000)}s, ${r.content.length} chars`
  )
  if (r.content.trim().length < Math.max(200, current.length / 4)) {
    console.log("  degenerate revision — keeping previous version")
    continue
  }
  current = r.content
}
fs.writeFileSync("/tmp/glyph-repaired.md", current)
console.log("\nfinal deliverable → /tmp/glyph-repaired.md")
const finalViolations = execViolations(current)
console.log(`final state: ${finalViolations.length} violation(s) remain`)
