import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import {
  extractResultText,
  failureSignature,
  interventionText,
  isFailureLoop,
  normalizeErrorLine,
  salientErrorLines
} from "./rca"

describe("salient error lines", () => {
  test("keeps failure lines, drops success summaries and blanks", () => {
    const lines = salientErrorLines(
      "Compiling 12 actions\n0 Error(s)\nno errors found\n" +
        "dotnet command failed with errorcode 1. Retrying in 1 seconds... (1/3)\n" +
        "Unhandled exception: IOException: Permission denied"
    )
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("dotnet command failed")
  })
})

describe("normalization", () => {
  test("retry counters and digits collapse to one signature", () => {
    const a = normalizeErrorLine("dotnet command failed with errorcode 1. Retrying in 1 seconds... (1/3)")
    const b = normalizeErrorLine("dotnet command failed with errorcode 1. Retrying in 2 seconds... (2/3)")
    expect(a).toBe(b)
  })

  test("absolute paths collapse to basenames", () => {
    const a = normalizeErrorLine("Access to the path '/home/demiurge/Shared/x/obj' is denied")
    const b = normalizeErrorLine("Access to the path '/tmp/other/place/obj' is denied")
    expect(a).toBe(b)
  })
})

describe("failure signatures", () => {
  test("null for clean output; stable for the same failure", () => {
    expect(failureSignature("All tests passed\n42 files compiled")).toBeNull()
    const s1 = failureSignature("RunUAT ERROR: AutomationTool was unable to run. Exited with code: 1")
    const s2 = failureSignature("RunUAT ERROR: AutomationTool was unable to run. Exited with code: 2")
    expect(s1).not.toBeNull()
    expect(s1).toBe(s2 as string)
  })

  test("extractResultText handles strings and content blocks", () => {
    expect(extractResultText("plain failure")).toBe("plain failure")
    expect(
      extractResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })
    ).toBe("a\nb")
  })
})

describe("isFailureLoop", () => {
  test("fires at threshold occurrences, even with other failures between", () => {
    const sig = "x"
    expect(isFailureLoop(["x", "y", "x", "z", "x"], sig, 3)).toBe(true)
    expect(isFailureLoop(["x", "y", "x"], sig, 3)).toBe(false)
    expect(isFailureLoop([], sig, 3)).toBe(false)
  })
})

describe("regression: the voxcraft symptom-patching run (019f4e13)", () => {
  const SESSION =
    "/home/demiurge/.pi/agent/sessions/--home-demiurge-Shared-Projects-voxcraft--/" +
    "2026-07-10T22-08-25-861Z_019f4e13-2705-70b9-b004-c2250987d2a5.jsonl"

  test.if(fs.existsSync(SESSION))("the recurring dotnet failure trips the detector", () => {
    // Session-scoped history (matches the wiring): the user steered between
    // recurrences, so an input-scoped detector would have stayed silent.
    const history: string[] = []
    let fired = false
    for (const line of fs.readFileSync(SESSION, "utf8").split("\n")) {
      if (line.trim() === "") continue
      const entry = JSON.parse(line) as {
        type?: string
        message?: { role?: string; isError?: boolean; content?: unknown }
      }
      if (entry.type !== "message" || entry.message?.role !== "toolResult") continue
      if (entry.message.isError !== true) continue
      const signature = failureSignature(extractResultText(entry.message))
      if (signature === null) continue
      history.push(signature)
      if (isFailureLoop(history, signature, 3)) fired = true
    }
    expect(fired).toBe(true)
  })
})

describe("intervention text", () => {
  test("names the count, quotes the failure, and orders the method", () => {
    const text = interventionText("dotnet command failed | second line", 3)
    expect(text).toContain("3 times")
    expect(text).toContain("dotnet command failed")
    expect(text).not.toContain("second line")
    for (const step of ["MECHANISM", "DIFFERENTIAL", "GROUND TRUTH", "ONE CHANGE"]) {
      expect(text).toContain(step)
    }
    expect(text.indexOf("MECHANISM")).toBeLessThan(text.indexOf("DIFFERENTIAL"))
  })
})
