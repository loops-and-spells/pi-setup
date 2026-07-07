import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { execSync } from "node:child_process"
import {
  collectVerificationCommands,
  failureReport,
  parseVerificationCommands,
  workspaceFingerprint
} from "./verify-gate"

const DOC = `# some-dir

## Local Contracts

- never do the bad thing

## Verification

- \`bun test\` — must pass before landing
- \`bun run typecheck\`
- prose bullet without a command
* \`make lint\` (star bullets count too)

## Child DOX Index

- none
`

describe("parseVerificationCommands", () => {
  test("extracts backticked commands from the Verification section only", () => {
    expect(parseVerificationCommands(DOC)).toEqual(["bun test", "bun run typecheck", "make lint"])
  })

  test("no Verification section → no commands", () => {
    expect(parseVerificationCommands("# doc\n\n## Purpose\n\n- `rm -rf /` in prose\n")).toEqual([])
  })

  test("empty section (DOX allows it) → no commands", () => {
    expect(parseVerificationCommands("## Verification\n\n## Child DOX Index\n")).toEqual([])
  })
})

describe("collectVerificationCommands", () => {
  test("unions the AGENTS.md chain upward, nearest first, deduped", () => {
    const root = fs.mkdtempSync("/tmp/verify-gate-test-")
    try {
      fs.mkdirSync(path.join(root, "apps/web"), { recursive: true })
      fs.writeFileSync(path.join(root, "AGENTS.md"), "## Verification\n- `bun run typecheck`\n")
      fs.writeFileSync(
        path.join(root, "apps/web/AGENTS.md"),
        "## Verification\n- `bun test`\n- `bun run typecheck`\n"
      )
      expect(collectVerificationCommands(path.join(root, "apps/web"))).toEqual([
        "bun test",
        "bun run typecheck"
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("workspaceFingerprint", () => {
  test("changes when a tracked file changes; null outside git", () => {
    const root = fs.mkdtempSync("/tmp/verify-gate-git-")
    try {
      expect(workspaceFingerprint(root)).toBeNull()
      execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: root })
      fs.writeFileSync(path.join(root, "a.txt"), "one\n")
      execSync("git add . && git commit -qm init", { cwd: root })
      const before = workspaceFingerprint(root)
      fs.writeFileSync(path.join(root, "a.txt"), "two\n")
      const after = workspaceFingerprint(root)
      expect(before).not.toBeNull()
      expect(after).not.toBeNull()
      expect(after).not.toBe(before)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("failureReport", () => {
  test("bounded, fenced, command-labelled", () => {
    const report = failureReport([
      { command: "bun test", ok: false, output: "x".repeat(5000) }
    ])
    expect(report).toContain("### `bun test` failed")
    expect(report.length).toBeLessThan(2300)
  })
})
