import { describe, expect, test } from "bun:test"
import { draftFormatViolations } from "../src/draft-checks"

const CODE_REQUEST = "Fix the bug. Reply with the complete module in ONE fenced ```python block."
const PROSE_REQUEST = "Summarize the design tradeoffs in two paragraphs."

describe("draftFormatViolations — spiral signatures the proxy can see", () => {
  test("empty answer (thinking ate the budget) is a violation", () => {
    expect(draftFormatViolations(CODE_REQUEST, "")).toHaveLength(1)
    expect(draftFormatViolations(CODE_REQUEST, "  \n ")[0]).toContain("empty")
  })

  test("unclosed fence (truncation) is a violation", () => {
    const truncated =
      "The mutation bug is in remove_category. Here is the complete corrected module:\n" +
      "```python\nimport threading\n\nclass Ledger:\n    def __init__(self, entries=None):\n"
    expect(draftFormatViolations(CODE_REQUEST, truncated).some((v) => v.includes("unclosed"))).toBe(true)
  })

  test("code demanded but absent is a violation", () => {
    const prose = "The bug is in remove_category: it mutates while iterating. ".repeat(4)
    const violations = draftFormatViolations(CODE_REQUEST, prose)
    expect(violations.some((v) => v.includes("no complete fenced code block"))).toBe(true)
  })

  test("clean code answer passes", () => {
    const good = "Fixed:\n```python\ndef f():\n    return 1\n```\nThe mutation bug is gone."
    expect(draftFormatViolations(CODE_REQUEST, good)).toEqual([])
  })

  test("prose requests do not demand code", () => {
    const answer = "The tradeoff is locality versus duplication. ".repeat(4)
    expect(draftFormatViolations(PROSE_REQUEST, answer)).toEqual([])
  })

  test("empty check short-circuits (no cascade of noise)", () => {
    expect(draftFormatViolations(CODE_REQUEST, "ok")).toHaveLength(1)
  })
})
