import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import {
  extractToolCalls,
  interventionText,
  isLooping,
  turnSignature
} from "./loop-guard"

const assistantTurn = (commands: string[]): unknown => ({
  role: "assistant",
  content: commands.map((command) => ({ type: "toolCall", name: "bash", arguments: { command } }))
})

describe("turn signatures", () => {
  test("identical call sets produce identical signatures; order matters", () => {
    const a = turnSignature(extractToolCalls(assistantTurn(["grep foo", "grep bar"])))
    const b = turnSignature(extractToolCalls(assistantTurn(["grep foo", "grep bar"])))
    const c = turnSignature(extractToolCalls(assistantTurn(["grep bar", "grep foo"])))
    expect(a).toBe(b as string)
    expect(a).not.toBe(c as string)
  })

  test("non-tool turns and non-assistant messages sign as null/empty", () => {
    expect(turnSignature(extractToolCalls({ role: "assistant", content: [{ type: "text", text: "done" }] }))).toBeNull()
    expect(extractToolCalls({ role: "user", content: [{ type: "toolCall", name: "bash", arguments: {} }] })).toEqual([])
  })
})

describe("isLooping", () => {
  test("fires only on threshold consecutive identical tool turns", () => {
    const sig = "bash:{\"command\":\"grep x\"}"
    expect(isLooping([sig, sig, sig], 3)).toBe(true)
    expect(isLooping([sig, sig], 3)).toBe(false)
    expect(isLooping([sig, "other", sig], 3)).toBe(false)
    expect(isLooping([null, null, null], 3)).toBe(false) // text turns never loop
    expect(isLooping(["a", "a", sig, sig, sig], 3)).toBe(true) // only the tail counts
  })
})

describe("regression: the voxcraft stuck session (019f4e13)", () => {
  const SESSION =
    "/home/demiurge/.pi/agent/sessions/--home-demiurge-Shared-Projects-voxcraft--/" +
    "2026-07-10T22-08-25-861Z_019f4e13-2705-70b9-b004-c2250987d2a5.jsonl"

  test.if(fs.existsSync(SESSION))("detector fires inside the observed repeat run", () => {
    const signatures: (string | null)[] = []
    let firedAt: number | null = null
    const lines = fs.readFileSync(SESSION, "utf8").split("\n").filter((l) => l.trim() !== "")
    for (const [i, line] of lines.entries()) {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string } }
      if (entry.type !== "message" || entry.message?.role !== "assistant") continue
      signatures.push(turnSignature(extractToolCalls(entry.message)))
      if (firedAt === null && isLooping(signatures, 3)) firedAt = i
    }
    // the second repeat run (entries ~90-104) must trip the guard
    expect(firedAt).not.toBeNull()
    expect(firedAt as number).toBeLessThan(lines.length - 1) // fired before the session's end
  })
})

describe("intervention text", () => {
  test("names the repetition count and demands a different action", () => {
    const text = interventionText(3)
    expect(text).toContain("3 times in a row")
    expect(text).toContain("DIFFERENT action")
  })
})
