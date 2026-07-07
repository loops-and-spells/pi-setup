/**
 * verify-gate: close the loop with ground truth.
 *
 * After any agent turn that changed files, run the project's own verification
 * commands (declared in the DOX AGENTS.md chain under "## Verification") and,
 * on failure, feed the failing output back to the model as a new turn —
 * bounded by a retry budget. Measured basis (pi-bench Harness Techniques
 * Study): one round of failing-test feedback took a model from 0/6 to 6/6;
 * executable checks beat LLM checking in both council studies.
 *
 * Commands come from AGENTS.md files from the cwd upward: bullet lines under
 * a "## Verification" heading whose first backticked span is the command,
 * e.g. `- \`bun test\` — must pass before landing`.
 */
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { execSync } from "node:child_process"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = path.join(os.homedir(), ".pi/agent/verify-gate.json")

interface Config {
  enabled: boolean
  maxRetries: number
  timeoutSec: number
}

const DEFAULTS: Config = { enabled: true, maxRetries: 2, timeoutSec: 300 }

const loadConfig = (): Config => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>) }
  } catch {
    return { ...DEFAULTS }
  }
}

const saveConfig = (cfg: Config): void => {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`)
}

// ---------------------------------------------------------------- pure logic

/** Backticked commands from bullets under "## Verification", until the next "## ". */
export const parseVerificationCommands = (markdown: string): string[] => {
  const section = markdown.split(/^##\s+Verification\s*$/m)[1]
  if (section === undefined) return []
  const body = section.split(/^##\s+/m)[0] ?? ""
  const commands: string[] = []
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*[-*]\s+`([^`]+)`/)
    if (m?.[1] !== undefined) commands.push(m[1])
  }
  return commands
}

/** Union of Verification commands in the AGENTS.md chain from cwd upward, deduped. */
export const collectVerificationCommands = (cwd: string): string[] => {
  const commands: string[] = []
  let dir = path.resolve(cwd)
  for (let depth = 0; depth < 12; depth++) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(dir, name)
      if (!fs.existsSync(p)) continue
      try {
        commands.push(...parseVerificationCommands(fs.readFileSync(p, "utf8")))
      } catch {
        // unreadable doc never blocks the gate
      }
      break // pi semantics: first context file per directory wins
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return [...new Set(commands)].slice(0, 5)
}

/** Cheap "did this turn touch files" signal; null when not in a git work tree. */
export const workspaceFingerprint = (cwd: string): string | null => {
  try {
    const status = execSync("git status --porcelain=v1 && git diff HEAD --numstat", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000
    })
    return status.toString()
  } catch {
    return null
  }
}

interface CommandResult {
  readonly command: string
  readonly ok: boolean
  readonly output: string
}

const runCommand = (command: string, cwd: string, timeoutSec: number): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-4000)
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      output += `\n[verify-gate: killed after ${timeoutSec}s]`
    }, timeoutSec * 1000)
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ command, ok: code === 0, output: output.trim() })
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ command, ok: false, output: String(e) })
    })
  })

export const failureReport = (failures: readonly CommandResult[]): string =>
  failures
    .map((f) => `### \`${f.command}\` failed\n\`\`\`\n${f.output.slice(-2000)}\n\`\`\``)
    .join("\n\n")

// ------------------------------------------------------------------ wiring

export default function verifyGate(pi: ExtensionAPI): void {
  const cfg = loadConfig()
  let retriesLeft = cfg.maxRetries
  let baselineFingerprint: string | null = null

  const verify = async (cwd: string): Promise<{ failures: CommandResult[]; ran: number }> => {
    const commands = collectVerificationCommands(cwd)
    const results: CommandResult[] = []
    for (const command of commands) {
      results.push(await runCommand(command, cwd, cfg.timeoutSec))
    }
    return { failures: results.filter((r) => !r.ok), ran: results.length }
  }

  pi.on("input", () => {
    retriesLeft = cfg.maxRetries
    baselineFingerprint = cfg.enabled ? workspaceFingerprint(process.cwd()) : null
  })

  pi.on("agent_end", async (_event, ctx) => {
    if (!cfg.enabled) return
    const cwd = process.cwd()
    // only gate turns that actually changed the work tree (and only in git repos,
    // where change detection is reliable)
    const now = workspaceFingerprint(cwd)
    if (now === null || now === baselineFingerprint) return
    baselineFingerprint = now

    const commands = collectVerificationCommands(cwd)
    if (commands.length === 0) return

    ctx.ui.setWorkingMessage(`verify-gate: running ${commands.length} check(s)…`)
    const { failures, ran } = await verify(cwd)
    ctx.ui.setWorkingMessage()
    if (failures.length === 0) {
      ctx.ui.setStatus("verify", `✓ ${ran} check(s)`)
      return
    }
    if (retriesLeft <= 0) {
      ctx.ui.setStatus("verify", `✗ ${failures.length}/${ran} failing (retry budget spent)`)
      ctx.ui.notify(
        `verify-gate: still failing after retries:\n${failures.map((f) => f.command).join(", ")}`,
        "warning"
      )
      return
    }
    retriesLeft--
    ctx.ui.setStatus("verify", `✗ ${failures.length}/${ran} failing — feeding back`)
    pi.sendMessage(
      {
        customType: "verify-gate",
        display: true,
        content:
          `Project verification failed after your changes. Fix the code so every check ` +
          `passes; do not weaken or delete the checks themselves. Do not mention this ` +
          `process in your answer.\n\n${failureReport(failures)}`
      },
      { triggerTurn: true }
    )
  })

  pi.registerCommand("verify", {
    description: "verify-gate — on|off|status|run|retries <n>|timeout <sec>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = "status", value] = args.trim().split(/\s+/).filter((s) => s !== "")
      if (sub === "on" || sub === "off") {
        cfg.enabled = sub === "on"
        saveConfig(cfg)
      } else if (sub === "retries" && value !== undefined) {
        cfg.maxRetries = Math.max(0, Number(value) || 0)
        saveConfig(cfg)
      } else if (sub === "timeout" && value !== undefined) {
        cfg.timeoutSec = Math.max(5, Number(value) || DEFAULTS.timeoutSec)
        saveConfig(cfg)
      } else if (sub === "run") {
        const cwd = process.cwd()
        const commands = collectVerificationCommands(cwd)
        if (commands.length === 0) {
          ctx.ui.notify("verify-gate: no Verification commands in the AGENTS.md chain", "warning")
          return
        }
        ctx.ui.setWorkingMessage(`verify-gate: running ${commands.length} check(s)…`)
        const { failures, ran } = await verify(cwd)
        ctx.ui.setWorkingMessage()
        ctx.ui.notify(
          failures.length === 0
            ? `verify-gate: ✓ all ${ran} check(s) pass`
            : `verify-gate: ✗ ${failures.length}/${ran} failing\n${failureReport(failures).slice(0, 1500)}`,
          failures.length === 0 ? "info" : "warning"
        )
        return
      }
      const commands = collectVerificationCommands(process.cwd())
      ctx.ui.notify(
        `verify-gate: ${cfg.enabled ? "ON" : "off"} — ${cfg.maxRetries} retr${cfg.maxRetries === 1 ? "y" : "ies"}/input, ` +
          `${cfg.timeoutSec}s/command\n  checks here: ${commands.length === 0 ? "(none in AGENTS.md chain)" : commands.join(" · ")}`,
        "info"
      )
    }
  })
}
