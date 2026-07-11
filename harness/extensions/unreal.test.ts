import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  buildScriptOf,
  detectProject,
  findEngineRoot,
  findUproject,
  isStale,
  newestRuleStamp,
  ubtArgs,
  type UnrealProject
} from "./unreal"

const CFG = { enabled: true, target: "UnrealEditor", platform: "Linux", configuration: "Development" }

/** Minimal UE project fixture: .uproject, game + engine Build.cs, Build.sh. */
const makeFixture = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unreal-ext-"))
  fs.writeFileSync(path.join(root, "Game.uproject"), "{}")
  fs.mkdirSync(path.join(root, "Source/GameMode"), { recursive: true })
  fs.writeFileSync(path.join(root, "Source/GameMode/GameMode.Build.cs"), "// game")
  const batch = path.join(root, "UnrealEngine/Engine/Build/BatchFiles/Linux")
  fs.mkdirSync(batch, { recursive: true })
  fs.writeFileSync(path.join(batch, "Build.sh"), "#!/bin/sh")
  // engine-owned Build.cs that must NOT count toward the project's rule stamp
  const engineSrc = path.join(root, "UnrealEngine/Engine/Source/Runtime/Core")
  fs.mkdirSync(engineSrc, { recursive: true })
  fs.writeFileSync(path.join(engineSrc, "Core.Build.cs"), "// engine")
  return root
}

const fixtures: string[] = []
const fixture = (): string => {
  const root = makeFixture()
  fixtures.push(root)
  return root
}
afterAll(() => {
  for (const root of fixtures) fs.rmSync(root, { recursive: true, force: true })
})

describe("project detection", () => {
  test("finds uproject, in-project engine, and composes the project", () => {
    const root = fixture()
    expect(findUproject(root)).toBe(path.join(root, "Game.uproject"))
    expect(findEngineRoot(root)).toBe(path.join(root, "UnrealEngine"))
    const project = detectProject(root)
    expect(project).not.toBeNull()
    expect(project?.engineRoot).toBe(path.join(root, "UnrealEngine"))
  })

  test("no uproject or no engine → null", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "unreal-empty-"))
    fixtures.push(empty)
    expect(detectProject(empty)).toBeNull()
    const noEngine = fs.mkdtempSync(path.join(os.tmpdir(), "unreal-noeng-"))
    fixtures.push(noEngine)
    fs.writeFileSync(path.join(noEngine, "Game.uproject"), "{}")
    expect(detectProject(noEngine)).toBeNull()
  })

  test("engineRoot override wins when valid", () => {
    const root = fixture()
    const other = fixture()
    const overridden = detectProject(root, path.join(other, "UnrealEngine"))
    expect(overridden?.engineRoot).toBe(path.join(other, "UnrealEngine"))
  })
})

describe("ubt invocation", () => {
  test("args target the project and write the database to the project root", () => {
    const root = fixture()
    const project = detectProject(root) as UnrealProject
    const args = ubtArgs(project, CFG)
    expect(args).toEqual([
      "UnrealEditor",
      "Linux",
      "Development",
      `-project=${path.join(root, "Game.uproject")}`,
      "-mode=GenerateClangDatabase",
      `-OutputDir=${root}`
    ])
    expect(buildScriptOf(project.engineRoot)).toEndWith("Engine/Build/BatchFiles/Linux/Build.sh")
  })
})

describe("staleness", () => {
  test("missing database is stale; fresh database is not", () => {
    const root = fixture()
    const project = detectProject(root) as UnrealProject
    expect(isStale(project)).toBe(true)
    fs.writeFileSync(path.join(root, "compile_commands.json"), "[]")
    expect(isStale(project)).toBe(false)
  })

  test("touching a project Build.cs makes the database stale; engine Build.cs does not", () => {
    const root = fixture()
    const project = detectProject(root) as UnrealProject
    fs.writeFileSync(path.join(root, "compile_commands.json"), "[]")
    const before = newestRuleStamp(project)
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(root, "UnrealEngine/Engine/Source/Runtime/Core/Core.Build.cs"), future, future)
    expect(newestRuleStamp(project)).toBe(before) // engine subtree excluded
    expect(isStale(project)).toBe(false)
    fs.utimesSync(path.join(root, "Source/GameMode/GameMode.Build.cs"), future, future)
    expect(isStale(project)).toBe(true)
  })
})

describe("regression: the real voxcraft checkout", () => {
  const VOXCRAFT = "/home/demiurge/Shared/Projects/voxcraft"

  test.if(fs.existsSync(path.join(VOXCRAFT, "Game.uproject")))(
    "detects the project whose database fixed the pi-lens false positives",
    () => {
      const project = detectProject(VOXCRAFT)
      expect(project).not.toBeNull()
      expect(project?.engineRoot).toBe(path.join(VOXCRAFT, "UnrealEngine"))
      expect(fs.existsSync(buildScriptOf(project!.engineRoot))).toBe(true)
      // the stamp walk must not drown in the engine subtree
      const start = Date.now()
      newestRuleStamp(project!)
      expect(Date.now() - start).toBeLessThan(5000)
    }
  )
})
