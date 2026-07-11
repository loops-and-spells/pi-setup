/**
 * unreal: real clangd intelligence for Unreal Engine projects.
 *
 * Failure mode (observed live, voxcraft 2026-07-10): pi-lens drives stock
 * clangd, and without a compilation database clangd cannot see UE's engine
 * headers — every UE source file drowns in false-positive errors. UnrealBuildTool
 * can emit exactly what clangd needs (`-mode=GenerateClangDatabase`), verified
 * on voxcraft: 38,707-entry compile_commands.json, `clangd --check` on
 * VoxCoreModule.cpp = 0 errors, engine headers resolved via Epic's bundled
 * sysroot.
 *
 * This extension automates that: at session start in a UE project (a
 * `*.uproject` beside an engine checkout), it regenerates the database in the
 * background whenever it is missing or older than the project's build rules
 * (*.uproject, *.Build.cs, *.Target.cs — engine subtree excluded). Generation
 * is UBT dependency analysis only (~80s on voxcraft), never a compile, and a
 * failure never breaks the session.
 */
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

const CONFIG_PATH = path.join(os.homedir(), ".pi/agent/unreal.json")

interface Config {
  enabled: boolean
  /** UBT target used for the database; UnrealEditor covers game modules and plugins. */
  target: string
  platform: string
  configuration: string
  /** Absolute engine root override when the engine is not inside the project. */
  engineRoot?: string
}

const DEFAULTS: Config = {
  enabled: true,
  target: "UnrealEditor",
  platform: "Linux",
  configuration: "Development"
}

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

export interface UnrealProject {
  /** Project root — the directory holding the .uproject. */
  readonly root: string
  /** Absolute path of the .uproject file. */
  readonly uproject: string
  /** Engine root — the directory containing Engine/. */
  readonly engineRoot: string
}

/** Build.sh of an engine checkout; existence defines a valid engine root. */
export const buildScriptOf = (engineRoot: string): string =>
  path.join(engineRoot, "Engine/Build/BatchFiles/Linux/Build.sh")

/** First *.uproject directly in `dir` (UE keeps it at the project root). */
export const findUproject = (dir: string): string | null => {
  try {
    const hit = fs.readdirSync(dir).find((f) => f.endsWith(".uproject"))
    return hit === undefined ? null : path.join(dir, hit)
  } catch {
    return null
  }
}

/** Engine root for a project: config override, in-project checkout, or a
 * sibling `UnrealEngine` directory — whichever has a Build.sh. */
export const findEngineRoot = (projectRoot: string, override?: string): string | null => {
  const candidates = [
    ...(override === undefined ? [] : [override]),
    path.join(projectRoot, "UnrealEngine"),
    path.join(path.dirname(projectRoot), "UnrealEngine")
  ]
  return candidates.find((c) => fs.existsSync(buildScriptOf(c))) ?? null
}

export const detectProject = (cwd: string, override?: string): UnrealProject | null => {
  const uproject = findUproject(cwd)
  if (uproject === null) return null
  const engineRoot = findEngineRoot(cwd, override)
  if (engineRoot === null) return null
  return { root: cwd, uproject, engineRoot }
}

/** UBT arguments that write compile_commands.json into the project root,
 * where pi-lens/clangd treat it as a C++ root marker. */
export const ubtArgs = (project: UnrealProject, cfg: Config): string[] => [
  cfg.target,
  cfg.platform,
  cfg.configuration,
  `-project=${project.uproject}`,
  "-mode=GenerateClangDatabase",
  `-OutputDir=${project.root}`
]

/** Newest mtime (ms) among the project's build rules: the .uproject plus every
 * *.Build.cs / *.Target.cs under the project — the engine subtree and
 * Intermediate/Saved/node_modules are excluded (the engine alone holds
 * thousands of Build.cs files that are not the project's business). */
export const newestRuleStamp = (project: UnrealProject): number => {
  const SKIP = new Set(["Intermediate", "Saved", "node_modules", ".git", "DerivedDataCache"])
  const engineReal = path.resolve(project.engineRoot)
  let newest = 0
  const stamp = (file: string): void => {
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs)
    } catch {
      // deleted mid-walk; ignore
    }
  }
  const walk = (dir: string): void => {
    if (path.resolve(dir) === engineReal) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(Build|Target)\.cs$/.test(entry.name)) stamp(full)
    }
  }
  stamp(project.uproject)
  walk(project.root)
  return newest
}

/** The database needs (re)generation when absent or older than the rules. */
export const isStale = (project: UnrealProject): boolean => {
  const db = path.join(project.root, "compile_commands.json")
  try {
    return fs.statSync(db).mtimeMs < newestRuleStamp(project)
  } catch {
    return true
  }
}

// ------------------------------------------------------------------ wiring

export default function unreal(pi: ExtensionAPI): void {
  const cfg = loadConfig()
  let generating = false

  const generate = (project: UnrealProject, ui: { notify: Function; setStatus: Function }): void => {
    if (generating) return
    generating = true
    const logDir = path.join(project.root, "Intermediate")
    fs.mkdirSync(logDir, { recursive: true })
    const logPath = path.join(logDir, "clang-database.log")
    const log = fs.openSync(logPath, "w")
    ui.setStatus("unreal", "⚙ generating clang database…")
    const child = spawn(buildScriptOf(project.engineRoot), ubtArgs(project, cfg), {
      cwd: project.root,
      stdio: ["ignore", log, log]
    })
    child.on("close", (code) => {
      fs.closeSync(log)
      generating = false
      if (code === 0) {
        ui.setStatus("unreal", "✓ clang database ready")
        ui.notify("unreal: compile_commands.json regenerated — clangd/pi-lens now see engine headers", "info")
      } else {
        ui.setStatus("unreal", "✗ clang database generation failed")
        ui.notify(`unreal: database generation failed (exit ${code}) — see ${logPath}`, "warning")
      }
    })
    child.on("error", () => {
      fs.closeSync(log)
      generating = false
      ui.setStatus("unreal", "✗ could not launch UnrealBuildTool")
    })
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!cfg.enabled) return
    try {
      const project = detectProject(process.cwd(), cfg.engineRoot)
      if (project === null || !isStale(project)) return
      generate(project, ctx.ui)
    } catch {
      // detection must never break a session
    }
  })

  pi.registerCommand("unreal", {
    description: "unreal — status|refresh|on|off",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = "status"] = args.trim().split(/\s+/).filter((s) => s !== "")
      if (sub === "on" || sub === "off") {
        cfg.enabled = sub === "on"
        saveConfig(cfg)
      }
      const project = detectProject(process.cwd(), cfg.engineRoot)
      if (sub === "refresh") {
        if (project === null) {
          ctx.ui.notify("unreal: no .uproject + engine checkout found here", "warning")
          return
        }
        generate(project, ctx.ui)
        return
      }
      const state =
        project === null
          ? "no UE project in cwd"
          : `${path.basename(project.uproject)} — database ${
              generating ? "generating…" : isStale(project) ? "STALE" : "fresh"
            }`
      ctx.ui.notify(`unreal: ${cfg.enabled ? "ON" : "off"} (${cfg.target}/${cfg.platform}) — ${state}`, "info")
    }
  })
}
