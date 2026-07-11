/**
 * rca: force root-cause analysis when the same failure keeps recurring.
 *
 * Failure mode (observed live, voxcraft session 019f4e13, 2026-07-10): the
 * model hits an error and starts patching the artifacts nearest to it —
 * different edits each turn, so loop-guard stays silent — while the SAME
 * failure keeps coming back ("dotnet command failed with errorcode 1" at
 * turns ~62, ~65 and ~80). Symptom-patching without a diagnosis.
 *
 * Detection is precision-first: only tool results flagged isError count,
 * their salient error lines are normalized (digits, paths, whitespace) into a
 * failure signature, and `threshold` recurrences of one signature within a
 * single user input trigger one steered intervention. The intervention is the
 * debugging method engineering actually uses:
 *   1. MECHANISM  — what code produces this exact error, checking what?
 *   2. DIFFERENTIAL — the 2–3 root causes that could trip that check
 *   3. GROUND TRUTH — one read-only observation to eliminate each candidate;
 *      observed state outranks file names, comments, and log claims
 *   4. ONE CHANGE — smallest fix at the surviving root cause, re-run the
 *      original failing command, revert what didn't help
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = path.join(os.homedir(), ".pi/agent/rca.json")

interface Config {
  enabled: boolean
  /** Recurrences of one failure signature that trigger the intervention. */
  threshold: number
  /** Interventions allowed per user input. */
  maxInterventions: number
}

const DEFAULTS: Config = { enabled: true, threshold: 3, maxInterventions: 1 }

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

/** Text of a tool result, whether given content blocks or a plain value. */
export const extractResultText = (result: unknown): string => {
  if (typeof result === "string") return result
  const r = result as { content?: unknown; output?: unknown; text?: unknown }
  if (typeof r?.text === "string") return r.text
  if (typeof r?.output === "string") return r.output
  if (Array.isArray(r?.content)) {
    return r.content
      .map((b) => {
        const block = b as { type?: string; text?: string }
        return typeof block?.text === "string" ? block.text : ""
      })
      .join("\n")
  }
  return ""
}

const SALIENT =
  /\b(error|fatal|failed|failure|exception|denied|traceback|panic|assert(?:ion)?|incompatible|missing module|cannot|unable to)\b/i

/** Lines that carry the failure. "0 errors"-style success summaries excluded. */
export const salientErrorLines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && SALIENT.test(l) && !/\b(0|no)\s+errors?\b/i.test(l))

/** Normalize a line so retry counters, paths, and addresses don't split
 * signatures: digits → #, path segments → basename, collapsed whitespace. */
export const normalizeErrorLine = (line: string): string =>
  line
    .toLowerCase()
    .replace(/(^|["'\s(=])\/[^\s"')]+\/([^\s"')/]+)/g, "$1$2") // /a/b/c.txt → c.txt
    .replace(/0x[0-9a-f]+/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)

/** Failure signature of one failed tool result; null when nothing salient. */
export const failureSignature = (resultText: string): string | null => {
  const lines = salientErrorLines(resultText).map(normalizeErrorLine)
  if (lines.length === 0) return null
  // Two lines discriminate failures well; a third often drags in run-specific
  // detail (paths, retry tails) that splits identical failures apart.
  return [...new Set(lines)].slice(0, 2).join(" | ")
}

/** True when `signature` has occurred `threshold` times in the history. */
export const isFailureLoop = (
  history: readonly string[],
  signature: string,
  threshold: number
): boolean => threshold >= 2 && history.filter((s) => s === signature).length >= threshold

export const interventionText = (signature: string, count: number): string =>
  `The same failure has now occurred ${count} times despite your changes:\n\n` +
  `    ${signature.split(" | ")[0]}\n\n` +
  `Different patches, same error — stop patching and diagnose. Work the method:\n` +
  `1. MECHANISM: quote the exact error line and state what mechanically produces it — ` +
  `which program, performing which check, comparing what against what. If you cannot ` +
  `state this, find the code or docs that emit the message before doing anything else.\n` +
  `2. DIFFERENTIAL: list the 2-3 root causes that could trip that mechanism.\n` +
  `3. GROUND TRUTH: eliminate each candidate with one read-only observation (ls, cat, ` +
  `config state). Observed state outranks file names, comments, docs, and log claims — ` +
  `scripts and comments can lie about what they do.\n` +
  `4. ONE CHANGE: fix the single surviving candidate with the smallest change, re-run ` +
  `the ORIGINAL failing command, and revert anything that did not help.\n` +
  `Do not edit any file until step 3 has eliminated all but one candidate.`

// ------------------------------------------------------------------ wiring

export default function rca(pi: ExtensionAPI): void {
  const cfg = loadConfig()
  // Failure history is SESSION-scoped: real failure loops span user inputs
  // ("try again" → same error). Only the intervention budget resets per input
  // — in the live voxcraft loop, a user steer between recurrences would have
  // silenced an input-scoped detector entirely.
  let history: string[] = []
  let interventionsLeft = cfg.maxInterventions

  pi.on("input", async () => {
    interventionsLeft = cfg.maxInterventions
  })

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!cfg.enabled) return
    if (!(event as { isError?: boolean }).isError) return
    const signature = failureSignature(extractResultText((event as { result?: unknown }).result))
    if (signature === null) return
    history.push(signature)
    history = history.slice(-32)
    if (interventionsLeft <= 0) return
    if (!isFailureLoop(history, signature, cfg.threshold)) return
    interventionsLeft--
    const count = history.filter((s) => s === signature).length
    history = history.filter((s) => s !== signature) // re-fire only if it re-establishes
    ctx.ui.setStatus("rca", `⚑ same failure ×${count} — steered to root-cause analysis`)
    try {
      pi.sendMessage(
        { customType: "rca", display: true, content: interventionText(signature, count) },
        { deliverAs: "steer" }
      )
    } catch {
      // steering can race the run ending; the status line still tells the story
    }
  })

  pi.registerCommand("rca", {
    description: "rca — status|on|off|threshold <n>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = "status", value] = args.trim().split(/\s+/).filter((s) => s !== "")
      if (sub === "on" || sub === "off") {
        cfg.enabled = sub === "on"
        saveConfig(cfg)
      } else if (sub === "threshold" && value !== undefined) {
        cfg.threshold = Math.max(2, Number(value) || DEFAULTS.threshold)
        saveConfig(cfg)
      }
      ctx.ui.notify(
        `rca: ${cfg.enabled ? "ON" : "off"} — fires when one failure signature recurs ` +
          `${cfg.threshold}×, ${cfg.maxInterventions} intervention(s)/input ` +
          `(${history.length} failure(s) tracked this input)`,
        "info"
      )
    }
  })
}
