/**
 * autonomy: make the agent act instead of delegating shell work to the user.
 *
 * Failure mode (mined from real sessions, 2026-07-10): the model ends a turn
 * by handing the user a runnable command — "you can run `cat …`, paste the
 * output", "just run it manually once" — even though it has a bash tool and
 * the command needs no privileges. Nothing in the harness told it to act:
 * the global DOX contract is documentation discipline only.
 *
 * Two layers, both bounded:
 *  1. An agency contract appended to the system prompt every turn — the model
 *     is the operator of this machine, not an advisor. Legitimate hand-offs
 *     (sudo, interactive logins, web UIs, other machines) stay hand-offs.
 *  2. A deflection steer: when a turn ends with NO tool calls and the text
 *     asks the user to run a non-sudo shell command, one steered message
 *     tells the model to run it itself. Precision-first — sudo and
 *     interactive commands never trigger it.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = path.join(os.homedir(), ".pi/agent/autonomy.json")

interface Config {
  enabled: boolean
  /** Inject the agency contract into the system prompt each turn. */
  prompt: boolean
  /** Steer when a turn deflects a runnable command to the user. */
  steer: boolean
  /** Steers allowed per user input. */
  maxInterventions: number
}

const DEFAULTS: Config = { enabled: true, prompt: true, steer: true, maxInterventions: 1 }

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

export const AGENCY_BLOCK = `## Agency

You are the operator of this machine, not an advisor. You have a bash tool.

- Never ask the user to run a command you can run yourself. Run it, read the output, and continue.
- Do not ask permission for reversible project work — builds, tests, file edits, installs, service checks. Act, then report what you did and what you found.
- Verify by executing. Do not tell the user what "should" work; run it and confirm.
- Hand a command to the user ONLY when it truly requires them: sudo/root, interactive logins or prompts, web UIs, or actions on another machine. Then give the exact command and ask for the result.
- When you finish a step and know the next one, take it. Stop only when done or genuinely blocked on the user.`

/** Concatenated text of an assistant message's text blocks; "" for anything else. */
export const extractText = (message: unknown): string => {
  const m = message as { role?: string; content?: unknown }
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return ""
  return m.content
    .map((b) => {
      const block = b as { type?: string; text?: string }
      return block?.type === "text" && typeof block.text === "string" ? block.text : ""
    })
    .filter((t) => t !== "")
    .join("\n")
}

/** True when the assistant message contains at least one tool call. */
export const hasToolCalls = (message: unknown): boolean => {
  const m = message as { role?: string; content?: unknown }
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return false
  return m.content.some((b) => (b as { type?: string })?.type === "toolCall")
}

/** Phrases that hand execution to the user. Kept narrow: greetings and option
 * questions ("let me know what you need") must NOT match. */
const DEFLECTION_PHRASES: readonly RegExp[] = [
  /\byou can (?:run|execute|try)\b/i,
  /\bplease (?:run|execute)\b/i,
  /\brun (?:the following|this|these) (?:command|script)s?\b/i,
  /\brun (?:it|this|these|that) (?:yourself|manually|in your terminal)\b/i,
  /\bin your terminal\b/i,
  /\byou(?:'ll| will) need to run\b/i,
  /\byou should run\b/i,
  /\bpaste the (?:output|result|error)\b/i,
  /\blet me know (?:the (?:output|result)s?|when it(?:'s| is) done|once (?:it|that)(?:'s| is| has)?)\b/i
]

/** Commands the agent genuinely cannot or should not run itself. */
const LEGITIMATE_HANDOFF = /\b(?:sudo|doas|su\s|ssh-keygen|gh auth|gcloud auth|az login|aws configure|docker login|npm login|passwd)\b/i

/** Shell commands offered to the user: fenced ```…``` blocks (any bash-ish
 * content) and inline `backtick` spans that look like commands. */
export const extractOfferedCommands = (text: string): string[] => {
  const commands: string[] = []
  const fenced = text.matchAll(/```(?:bash|sh|shell|zsh|console)?\n([\s\S]*?)```/g)
  for (const m of fenced) {
    const body = (m[1] ?? "").trim()
    if (body !== "") commands.push(body)
  }
  const inline = text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]{2,200})`/g)
  for (const m of inline) {
    const span = (m[1] ?? "").trim()
    // command-shaped: starts with a plausible program token followed by an arg
    if (/^[a-z][a-z0-9_.\/-]*\s+\S/.test(span)) commands.push(span)
  }
  return commands
}

export interface Deflection {
  readonly phrase: string
  readonly command: string
}

/**
 * A deflection is: no tool calls this turn, a hand-off phrase, and offered
 * commands the agent could run itself. If ANY offered command is a legitimate
 * hand-off (sudo, login, …) the whole turn is treated as legitimate — mixed
 * turns ("sudo this, then I'll build") usually chain on the privileged step.
 * Returns null when the turn is fine.
 */
export const detectDeflection = (message: unknown): Deflection | null => {
  if (hasToolCalls(message)) return null
  const text = extractText(message)
  if (text === "") return null
  const phrase = DEFLECTION_PHRASES.find((p) => p.test(text))
  if (phrase === undefined) return null
  const offered = extractOfferedCommands(text)
  if (offered.length === 0 || offered.some((c) => LEGITIMATE_HANDOFF.test(c))) return null
  const match = text.match(phrase)
  return { phrase: match?.[0] ?? phrase.source, command: offered[0] as string }
}

export const interventionText = (deflection: Deflection): string =>
  `You just asked the user to run a command ("${deflection.phrase}") that you can run ` +
  `yourself with the bash tool:\n\n    ${deflection.command.split("\n")[0]}\n\n` +
  `Run it now, read the output, and continue the task with the result. Only hand a ` +
  `command to the user when it genuinely requires them (sudo, interactive login, web UI, ` +
  `another machine).`

// ------------------------------------------------------------------ wiring

export default function autonomy(pi: ExtensionAPI): void {
  const cfg = loadConfig()
  let interventionsLeft = cfg.maxInterventions

  pi.on("input", async () => {
    interventionsLeft = cfg.maxInterventions
  })

  pi.on("before_agent_start", async (event) => {
    if (!cfg.enabled || !cfg.prompt) return
    return { systemPrompt: `${event.systemPrompt}\n\n${AGENCY_BLOCK}` }
  })

  pi.on("turn_end", async (event, ctx) => {
    if (!cfg.enabled || !cfg.steer || interventionsLeft <= 0) return
    const deflection = detectDeflection(event.message)
    if (deflection === null) return
    interventionsLeft--
    ctx.ui.setStatus("autonomy", "⚡ steered a hand-off back to the agent")
    try {
      pi.sendMessage(
        { customType: "autonomy", display: true, content: interventionText(deflection) },
        { deliverAs: "steer" }
      )
    } catch {
      // steering can race the run ending; the status line still tells the story
    }
  })

  pi.registerCommand("autonomy", {
    description: "autonomy — status|on|off|prompt on|off|steer on|off",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = "status", value] = args.trim().split(/\s+/).filter((s) => s !== "")
      if (sub === "on" || sub === "off") {
        cfg.enabled = sub === "on"
        saveConfig(cfg)
      } else if ((sub === "prompt" || sub === "steer") && (value === "on" || value === "off")) {
        cfg[sub] = value === "on"
        saveConfig(cfg)
      }
      ctx.ui.notify(
        `autonomy: ${cfg.enabled ? "ON" : "off"} — prompt ${cfg.prompt ? "on" : "off"}, ` +
          `steer ${cfg.steer ? "on" : "off"} (${cfg.maxInterventions}/input)`,
        "info"
      )
    }
  })
}
