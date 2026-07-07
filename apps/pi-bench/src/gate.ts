import * as fs from "node:fs"
import * as path from "node:path"
import type { BenchTask, GateOutcome } from "./types"

/**
 * Objective scoring for gated tasks: extract the solution code block from the
 * answer, drop it into a tmpdir beside the task's repoContext files, run the
 * hidden tests, and count CHECK lines. Everything here is deterministic code —
 * no model ever sees the tests or participates in scoring.
 */

/** check() is prepended so task tests stay terse and one crash can't hide the other checks. */
const CHECK_HELPER = `def check(name, fn):
    try:
        fn()
        print(f"CHECK {name}: PASS", flush=True)
    except BaseException as e:
        print(f"CHECK {name}: FAIL: {type(e).__name__}: {e}", flush=True)

`

/**
 * The deliverable contract for gated tasks is "one fenced python block".
 * Models often add extra snippets around it, so take the largest python-tagged
 * block, falling back to the largest block of any tag.
 */
export const extractSolution = (answer: string): string | undefined => {
  const tagged = [...answer.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
  const any = [...answer.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
  const pool = tagged.length > 0 ? tagged : any
  if (pool.length === 0) return undefined
  return pool.reduce((a, b) => (b.length > a.length ? b : a))
}

const CHECK_LINE = /^CHECK (.+?): (PASS|FAIL)(?:: (.*))?$/

export const runGate = (task: BenchTask, answer: string): GateOutcome => {
  const gate = task.gate
  if (gate === undefined) throw new Error(`task ${task.id} has no gate`)
  const total = gate.totalChecks
  const solution = extractSolution(answer)
  if (solution === undefined || solution.trim() === "") {
    return { passed: 0, total, failures: [], error: "no fenced code block found in the answer" }
  }
  const dir = fs.mkdtempSync(`/tmp/pi-bench-gate-${task.id}-`)
  try {
    for (const [rel, content] of Object.entries(task.repoContext?.files ?? {})) {
      const p = path.join(dir, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content)
    }
    // the solution replaces the target file (or stands alone as solution.py)
    fs.writeFileSync(path.join(dir, task.repoContext?.target ?? "solution.py"), solution)
    fs.writeFileSync(path.join(dir, "run_gate_tests.py"), CHECK_HELPER + gate.tests)
    const run = Bun.spawnSync(
      ["timeout", String(gate.timeoutSec ?? 30), "python3", "run_gate_tests.py"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" }
    )
    const stdout = new TextDecoder().decode(run.stdout)
    const stderr = new TextDecoder().decode(run.stderr).trim()
    let passed = 0
    const failures: string[] = []
    for (const line of stdout.split("\n")) {
      const m = line.match(CHECK_LINE)
      if (m === null) continue
      if (m[2] === "PASS") passed++
      else failures.push(`${m[1]}: ${m[3] ?? "failed"}`)
    }
    if (run.exitCode === 124) {
      return { passed, total, failures, error: `tests timed out after ${gate.timeoutSec ?? 30}s` }
    }
    // a crash before/between checks (import error, top-level exception) ends the run early
    if (run.exitCode !== 0 && passed + failures.length < total) {
      const tail = stderr.split("\n").slice(-3).join("\n")
      return { passed, total, failures, error: `tests crashed: ${tail || "unknown error"}` }
    }
    return { passed, total, failures }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Gate findings phrased as revision-prompt violations for the verify loop. */
export const gateViolations = (outcome: GateOutcome): string[] => {
  const violations = outcome.failures.map(
    (f) => `Hidden test failed — ${f}. Fix the code so this behavior is correct.`
  )
  if (outcome.error !== undefined) {
    violations.push(
      `The solution could not be tested: ${outcome.error}. The answer must contain the ` +
        `complete corrected module in ONE fenced python code block.`
    )
  }
  return violations
}
