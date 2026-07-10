import { describe, expect, test } from "bun:test"
import { extractSolution, gateViolations, runGate } from "../src/gate"
import { symbolMap } from "../src/runner"
import { loadTasks } from "../src/tasks"
import type { BenchTask } from "../src/types"

/**
 * Offline evidence for the gate machinery: reference solutions must score
 * 100%, the planted-bug originals must fail exactly the planted checks, and
 * scoring must be robust to the ways models wrap their answers. No model or
 * GPU is involved.
 */

const task = (id: string): BenchTask => {
  const t = loadTasks([id])[0]
  if (t === undefined) throw new Error(`task ${id} missing`)
  return t
}

const fenced = (code: string): string => `Here is the corrected module:\n\n\`\`\`python\n${code}\`\`\`\n`

const CORRECT_LEDGER = `import threading


class Ledger:
    def __init__(self, entries=None):
        self.entries = [] if entries is None else entries
        self.lock = threading.Lock()
        self._balance_cache = None

    def add(self, amount, category):
        if amount == 0:
            return False
        with self.lock:
            self.entries.append({"amount": amount, "category": category})
            self._balance_cache = None
        return True

    def balance(self):
        if self._balance_cache is None:
            self._balance_cache = sum(e["amount"] for e in self.entries)
        return self._balance_cache

    def by_category(self, category):
        return [e for e in self.entries if e["category"] == category]

    def top(self, n):
        return sorted(self.entries, key=lambda e: e["amount"], reverse=True)[:n]

    def remove_category(self, category):
        with self.lock:
            self.entries[:] = [e for e in self.entries if e["category"] != category]
            self._balance_cache = None
`

const CORRECT_INTERVALSET = `class IntervalSet:
    def __init__(self):
        self._iv = []

    @staticmethod
    def _validate(start, end):
        if start >= end:
            raise ValueError(f"invalid range: [{start}, {end})")

    def add(self, start, end):
        self._validate(start, end)
        out = []
        for s, e in self._iv:
            if e < start or s > end:
                out.append((s, e))
            else:
                start = min(start, s)
                end = max(end, e)
        out.append((start, end))
        self._iv = sorted(out)

    def remove(self, start, end):
        self._validate(start, end)
        out = []
        for s, e in self._iv:
            if e <= start or s >= end:
                out.append((s, e))
            else:
                if s < start:
                    out.append((s, start))
                if e > end:
                    out.append((end, e))
        self._iv = sorted(out)

    def contains(self, x):
        return any(s <= x < e for s, e in self._iv)

    def total(self):
        return sum(e - s for s, e in self._iv)

    def intervals(self):
        return list(self._iv)
`

const CORRECT_ORDERS = `"""Checkout: price a cart, apply the discount, reserve the stock."""

import inventory
import pricing


def checkout(cart, discount_percent):
    if not 0 <= discount_percent <= 100:
        raise ValueError(f"percent out of range: {discount_percent}")
    total = 0
    reservations = []
    try:
        for sku, qty in cart:
            total += pricing.unit_price_cents(sku) * qty
            reservations.append(inventory.reserve(sku, qty))
    except inventory.OutOfStock:
        for rid in reservations:
            inventory.release(rid)
        raise
    return pricing.apply_discount(total, discount_percent)
`

describe("reference solutions pass their gates completely", () => {
  test("gate-bugfix", () => {
    const outcome = runGate(task("gate-bugfix"), fenced(CORRECT_LEDGER))
    expect(outcome.error).toBeUndefined()
    expect(outcome.failures).toEqual([])
    expect(outcome.passed).toBe(outcome.total)
  })

  test("gate-impl", () => {
    const outcome = runGate(task("gate-impl"), fenced(CORRECT_INTERVALSET))
    expect(outcome.error).toBeUndefined()
    expect(outcome.failures).toEqual([])
    expect(outcome.passed).toBe(outcome.total)
  })

  test("gate-repo", () => {
    const outcome = runGate(task("gate-repo"), fenced(CORRECT_ORDERS))
    expect(outcome.error).toBeUndefined()
    expect(outcome.failures).toEqual([])
    expect(outcome.passed).toBe(outcome.total)
  })
})

describe("planted-bug originals fail exactly the planted checks", () => {
  test("gate-bugfix: buggy Ledger scores 1/6 (only the regression check)", () => {
    const t = task("gate-bugfix")
    // the buggy module is embedded in the prompt — the strongest no-op answer
    const buggy = t.prompt.match(/```python\n([\s\S]*?)```/)?.[1] ?? ""
    const outcome = runGate(t, fenced(buggy))
    expect(outcome.passed).toBe(1)
    const failedChecks = outcome.failures.map((f) => f.split(":")[0])
    expect(failedChecks.sort()).toEqual([
      "balance-invalidated",
      "category-equality",
      "instances-isolated",
      "remove-all-matching",
      "top-largest-first"
    ])
  })

  test("gate-repo: buggy orders.py scores 2/8", () => {
    const t = task("gate-repo")
    const buggy = t.repoContext?.files["orders.py"] ?? ""
    const outcome = runGate(t, fenced(buggy))
    expect(outcome.passed).toBe(2)
    const failedChecks = outcome.failures.map((f) => f.split(":")[0]).sort()
    expect(failedChecks).toEqual([
      "discount-whole-percent",
      "invalid-discount-no-reserve",
      "no-reservation-leak",
      "outofstock-propagates",
      "rounding-half-up",
      "total-in-cents"
    ])
  })

  test("gate-impl: adjacency-blind implementation fails only merge-adjacent", () => {
    // classic subtle miss: merges overlaps but not touching intervals
    const naive = CORRECT_INTERVALSET.replace("if e < start or s > end:", "if e <= start or s >= end:")
    const outcome = runGate(task("gate-impl"), fenced(naive))
    expect(outcome.failures.map((f) => f.split(":")[0])).toEqual(["merge-adjacent"])
    expect(outcome.passed).toBe(outcome.total - 1)
  })
})

describe("gate robustness", () => {
  test("no code block → error outcome, score 0, stable denominator", () => {
    const outcome = runGate(task("gate-impl"), "I would implement it with a sorted list.")
    expect(outcome.passed).toBe(0)
    expect(outcome.total).toBe(9)
    expect(outcome.error).toContain("no fenced code block")
  })

  test("crashing solution → error outcome, not a hang", () => {
    const outcome = runGate(task("gate-impl"), fenced("raise RuntimeError('boom')\n"))
    expect(outcome.passed).toBe(0)
    expect(outcome.error).toContain("crashed")
  })

  test("infinite loop is cut by the timeout", () => {
    const t = { ...task("gate-impl"), gate: { ...task("gate-impl").gate!, timeoutSec: 2 } }
    const outcome = runGate(t, fenced("while True:\n    pass\n"))
    expect(outcome.error).toContain("timed out")
  })

  test("largest python block wins over stray snippets", () => {
    const answer = `Usage example:\n\`\`\`python\nx = IntervalSet()\n\`\`\`\n${fenced(CORRECT_INTERVALSET)}`
    expect(extractSolution(answer)).toContain("class IntervalSet")
  })

  test("gate violations narrate failures for the verify loop", () => {
    const outcome = runGate(task("gate-impl"), fenced("class IntervalSet:\n    pass\n"))
    const violations = gateViolations(outcome)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]).toContain("Hidden test failed")
  })
})

describe("symbol map", () => {
  test("carries signatures and docstring contracts, drops bodies", async () => {
    const files = task("gate-repo").repoContext?.files ?? {}
    const map = await symbolMap({ "pricing.py": files["pricing.py"] ?? "" })
    expect(map).toContain("def apply_discount(total_cents, percent)")
    expect(map).toContain("WHOLE-NUMBER percentage")
    expect(map).not.toContain("ROUND_HALF_UP)") // implementation detail stays out
    // ~an order of magnitude smaller than the full file
    expect(map.length).toBeLessThan((files["pricing.py"] ?? "").length * 0.6)
  })
})
