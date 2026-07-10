import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  appendPending,
  distillerMessages,
  harvestAll,
  harvestFile,
  loadPending,
  loadRules,
  looksLikeSecret,
  mergeRules,
  parseDistilled,
  parseRules,
  recordSnapshot,
  renderRulesFile,
  renderTasteBlock,
  resolveEndpoint,
  stripDiffHeader
} from "./taste"

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "taste-test-"))

describe("rules round trip", () => {
  test("parseRules reads what renderRulesFile writes", () => {
    const rules = ["Use pathlib.Path, never os.path", "Type-annotate every function"]
    expect(parseRules(renderRulesFile(rules))).toEqual(rules)
  })

  test("parseRules ignores non-bullet lines", () => {
    expect(parseRules("# Title\n\nprose here\n- only rule\n  indented prose")).toEqual([
      "only rule"
    ])
  })
})

describe("renderTasteBlock", () => {
  test("empty rules render nothing, and header alone renders nothing", () => {
    expect(renderTasteBlock([], 2000)).toBe("")
    // budget too small for even one rule → no block at all
    expect(renderTasteBlock(["a rule that is long enough"], 30)).toBe("")
  })

  test("stops adding rules at the char budget", () => {
    const rules = Array.from({ length: 50 }, (_, i) => `rule number ${i} with some padding text`)
    const block = renderTasteBlock(rules, 500)
    expect(block.length).toBeLessThanOrEqual(500)
    expect(block).toContain("rule number 0")
    expect(block).not.toContain("rule number 49")
  })
})

describe("mergeRules", () => {
  test("dedupes case/punctuation variants, primary order wins, capped", () => {
    const merged = mergeRules(
      ["Use f-strings, never .format()", "Prefer dataclasses"],
      ["use f-strings never format", "Old surviving rule"],
      2
    )
    expect(merged).toEqual(["Use f-strings, never .format()", "Prefer dataclasses"])
    expect(mergeRules(["a b c"], ["d e f"], 5)).toEqual(["a b c", "d e f"])
  })
})

describe("parseDistilled", () => {
  test("keeps bullets, drops secrets, prose, and degenerate lines", () => {
    const text = [
      "Here are the rules:",
      "- Use pathlib.Path for filesystem paths",
      "- api_key = sk_live_abcdefgh12345678 stays out",
      "- ok",
      `- ${"x".repeat(300)}`,
      "* Prefer explicit re-exports in __init__.py"
    ].join("\n")
    expect(parseDistilled(text)).toEqual([
      "Use pathlib.Path for filesystem paths",
      "Prefer explicit re-exports in __init__.py"
    ])
  })

  test("looksLikeSecret flags long random blobs", () => {
    expect(looksLikeSecret(`token: ${"A1b2C3d4".repeat(5)}`)).toBe(true)
    expect(looksLikeSecret("Raise ValueError with the offending value in the message")).toBe(false)
  })
})

describe("stripDiffHeader", () => {
  test("removes git headers, keeps hunks", () => {
    const diff = [
      "diff --git a/tmp/x.snap b/src/y.py",
      "index 123..456 100644",
      "--- a/tmp/x.snap",
      "+++ b/src/y.py",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line"
    ].join("\n")
    expect(stripDiffHeader(diff)).toBe("@@ -1,2 +1,2 @@\n-old line\n+new line")
  })
})

describe("observe → harvest cycle", () => {
  test("agent write then user edit yields exactly one diff, baseline refreshes", () => {
    const dir = tmp()
    const work = tmp()
    const file = path.join(work, "mod.py")

    fs.writeFileSync(file, "def f(x):\n    return x * 2\n")
    recordSnapshot(dir, file) // agent wrote this

    // no user edit yet → nothing to harvest
    expect(harvestFile(dir, file)).toBeNull()

    // user rewrites the function their way
    fs.writeFileSync(file, "def f(x: int) -> int:\n    return x * 2\n")
    const diff = harvestFile(dir, file)
    expect(diff).not.toBeNull()
    expect(diff?.file).toBe(file)
    expect(diff?.diff).toContain("+def f(x: int) -> int:")

    // baseline refreshed: same edit never harvested twice
    expect(harvestFile(dir, file)).toBeNull()
  })

  test("harvestAll captures pending diffs and survives deleted files", () => {
    const dir = tmp()
    const work = tmp()
    const kept = path.join(work, "kept.py")
    const gone = path.join(work, "gone.py")
    fs.writeFileSync(kept, "a = 1\n")
    fs.writeFileSync(gone, "b = 2\n")
    recordSnapshot(dir, kept)
    recordSnapshot(dir, gone)

    fs.writeFileSync(kept, "a = 1  # user comment\n")
    fs.rmSync(gone)

    expect(harvestAll(dir)).toBe(1)
    const pending = loadPending(dir)
    expect(pending.length).toBe(1)
    expect(pending[0]?.diff).toContain("user comment")
  })

  test("appendPending caps the pool", () => {
    const dir = tmp()
    for (let i = 0; i < 60; i++) {
      appendPending(dir, { file: `f${i}`, diff: `+line ${i}`, at: "2026-07-10T00:00:00Z" })
    }
    const pending = loadPending(dir)
    expect(pending.length).toBe(50)
    expect(pending[0]?.file).toBe("f10") // oldest dropped
  })
})

describe("endpoint resolution", () => {
  test("finds the provider serving the default model; null when unknown", () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ defaultModel: "m-2" }))
    fs.writeFileSync(
      path.join(dir, "models.json"),
      JSON.stringify({
        providers: {
          a: { baseUrl: "http://localhost:1111/v1", apiKey: "k1", models: [{ id: "m-1" }] },
          b: { baseUrl: "http://localhost:2222/v1/", apiKey: "k2", models: [{ id: "m-2" }] }
        }
      })
    )
    expect(resolveEndpoint(dir)).toEqual({
      url: "http://localhost:2222/v1/chat/completions",
      model: "m-2",
      apiKey: "k2"
    })
    expect(resolveEndpoint(dir, "m-1")?.url).toBe("http://localhost:1111/v1/chat/completions")
    expect(resolveEndpoint(dir, "nope")).toBeNull()
  })
})

describe("distiller prompt", () => {
  test("carries existing rules, diffs, and the rule cap", () => {
    const msgs = distillerMessages(
      ["Existing rule"],
      [{ file: "/w/x.py", diff: "+new", at: "2026-07-10T12:00:00Z" }],
      25
    )
    expect(msgs[0]?.role).toBe("system")
    expect(msgs[0]?.content).toContain("at most 25 rules")
    expect(msgs[1]?.content).toContain("- Existing rule")
    expect(msgs[1]?.content).toContain("### /w/x.py (2026-07-10)")
    expect(msgs[1]?.content).toContain("```diff\n+new\n```")
  })

  test("loadRules on a fresh dir is empty", () => {
    expect(loadRules(tmp())).toEqual([])
  })
})
