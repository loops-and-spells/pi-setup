/**
 * repo-map: inject a compact symbol map of the repository every turn.
 *
 * Measured basis (pi-bench ctx study): removing cross-file context cost a
 * model gate-repo (hallucinated another module's signature); a
 * signatures+docstrings map fully recovered full-file quality at a fraction
 * of the tokens. This extension gives every pi session that map for the repo
 * it is standing in: public surface + doc contracts, no bodies.
 *
 * Extraction lives in @pi-setup/core's repo-map (tree-sitter WASM grammars —
 * one mechanism for every language, no external language servers; measured
 * regex extractors as fallback). pi-bench's ctx-map config renders through
 * the same implementation, so the A/B measures exactly what this injects.
 * Complements pi-lens: the map orients up front (push); lens navigates on
 * demand (pull).
 *
 * Deterministic and git-aware: files come from `git ls-files` (no map outside
 * a git repo), the map is cached per workspace fingerprint (HEAD + porcelain
 * status), and the injected block is hard-capped by a char budget.
 * `/repomap` — status|on|off|show|refresh.
 */
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as url from "node:url"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

/**
 * pi loads this file via its ~/.pi/agent symlink and resolves imports from
 * that path, where the repo's node_modules don't exist. Resolve our realpath
 * (the repo checkout) and import the core builder from there at runtime; the
 * type-only import keeps full typing and is erased at runtime.
 */
type CoreRepoMap = typeof import("../../packages/core/src/repo-map")
let corePromise: Promise<CoreRepoMap> | null = null
const loadCore = (): Promise<CoreRepoMap> => {
  corePromise ??= (async () => {
    const here = fs.realpathSync(url.fileURLToPath(import.meta.url))
    const target = path.resolve(path.dirname(here), "../../packages/core/src/repo-map.ts")
    return (await import(target)) as CoreRepoMap
  })()
  return corePromise
}

const CONFIG_PATH = path.join(os.homedir(), ".pi/agent/repo-map.json")

interface Config {
  enabled: boolean
  /** Char budget for the injected map block. */
  budgetChars: number
  maxFiles: number
}

const DEFAULTS: Config = { enabled: true, budgetChars: 12000, maxFiles: 400 }

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

const MAX_FILE_BYTES = 128 * 1024

const git = (args: string, cwd: string): string | null => {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 10000 })
      .toString()
      .trim()
  } catch {
    return null
  }
}

const workspaceFingerprint = (cwd: string): string | null => {
  const head = git("rev-parse HEAD", cwd)
  if (head === null) return null
  return `${head}\n${git("status --porcelain=v1", cwd) ?? ""}`
}

export const buildMapFor = async (
  cwd: string,
  budgetChars: number,
  maxFiles: number
): Promise<string> => {
  const listed = git("ls-files", cwd)
  if (listed === null || listed === "") return ""
  const core = await loadCore()
  const files: Record<string, string> = {}
  for (const rel of core.selectMapFiles(listed.split("\n"), maxFiles)) {
    try {
      const p = path.join(cwd, rel)
      if (fs.statSync(p).size > MAX_FILE_BYTES) continue
      files[rel] = fs.readFileSync(p, "utf8")
    } catch {
      // deleted-but-tracked files never block the map
    }
  }
  return core.fitToBudget(await core.buildSymbolMap(files), budgetChars)
}

export default function repoMap(pi: ExtensionAPI): void {
  const cfg = loadConfig()
  let cachedFingerprint: string | null = null
  let cachedMap = ""

  const currentMap = async (cwd: string): Promise<string> => {
    const fp = workspaceFingerprint(cwd)
    if (fp === null) return "" // not a git repo — no map
    if (fp !== cachedFingerprint) {
      cachedFingerprint = fp
      cachedMap = await buildMapFor(cwd, cfg.budgetChars, cfg.maxFiles)
    }
    return cachedMap
  }

  pi.on("before_agent_start", async (event) => {
    if (!cfg.enabled) return
    let map: string
    try {
      map = await currentMap(process.cwd())
    } catch {
      return // a broken map build must never break the turn
    }
    if (map === "") return
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n## Repository symbol map\n` +
        `Signatures and doc contracts of this repo's public surface (bodies omitted). ` +
        `Trust it for cross-file calls; read the file when you need the implementation.\n\n${map}`
    }
  })

  pi.registerCommand("repomap", {
    description: "repo-map — status|on|off|show|refresh",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/)[0] ?? "status"
      if (sub === "on" || sub === "off") {
        cfg.enabled = sub === "on"
        saveConfig(cfg)
      } else if (sub === "refresh") {
        cachedFingerprint = null
        ctx.ui.notify(`repo-map: rebuilt (${(await currentMap(process.cwd())).length} chars)`, "info")
        return
      } else if (sub === "show") {
        const map = await currentMap(process.cwd())
        ctx.ui.notify(map === "" ? "repo-map: no map here (not a git repo?)" : map.slice(0, 3000), "info")
        return
      }
      const map = await currentMap(process.cwd())
      ctx.ui.notify(
        `repo-map: ${cfg.enabled ? "ON" : "off"} — ${map.length}/${cfg.budgetChars} chars here, ` +
          `${cfg.maxFiles} file cap`,
        "info"
      )
    }
  })
}
