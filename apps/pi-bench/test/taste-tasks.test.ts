import { describe, expect, test } from "bun:test"
import { runGate } from "../src/gate"
import { loadTasks } from "../src/tasks"
import { GENERIC_TASTE_RULES, TASTE_INJECT_CHARS, renderTasteBlock } from "../src/taste"
// bun test does not typecheck, so the cross-package import is safe here — it
// exists to keep the bench renderer byte-identical to what production injects
import { renderTasteBlock as harnessRenderTasteBlock } from "../../../harness/extensions/taste"
import type { BenchTask } from "../src/types"

const task = (id: string): BenchTask => {
  const t = loadTasks([id])[0]
  if (t === undefined) throw new Error(`missing task ${id}`)
  return t
}

const fence = (code: string): string => `Here is the module:\n\n\`\`\`python\n${code}\n\`\`\`\n`

// -------------------------------------------------- reference solutions (100%)

const SLUGIFY_REFERENCE = `"""Slug utilities."""
import re

__all__ = ["slugify"]


def slugify(title: str) -> str:
    """Convert a title into a URL slug; raises ValueError on invalid input."""
    if not isinstance(title, str) or title == "":
        raise ValueError(f"invalid title: {title!r}")
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
`

const MANIFEST_REFERENCE = `"""Order manifest reading."""
from dataclasses import dataclass
from pathlib import Path

__all__ = ["Item", "parse_manifest", "total_cents", "load_manifest"]


@dataclass(frozen=True)
class Item:
    """One manifest line: an item name, a quantity, and a unit price in cents."""

    name: str
    quantity: int
    unit_price_cents: int


def parse_manifest(text: str) -> list:
    """Parse manifest text into Item records, in input order; ValueError on bad lines."""
    items = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split(",")
        if len(parts) != 3:
            raise ValueError(f"malformed manifest line: {stripped!r}")
        try:
            quantity, price = int(parts[1]), int(parts[2])
        except ValueError as exc:
            raise ValueError(f"malformed manifest line: {stripped!r}") from exc
        if quantity < 0 or price < 0:
            raise ValueError(f"malformed manifest line: {stripped!r}")
        items.append(Item(name=parts[0].strip(), quantity=quantity, unit_price_cents=price))
    return items


def total_cents(items: list) -> int:
    """Total of quantity * unit_price_cents across the records."""
    return sum(i.quantity * i.unit_price_cents for i in items)


def load_manifest(path: str) -> list:
    """Read a manifest file from disk and return the parsed records."""
    return parse_manifest(Path(path).read_text())
`

// ------------------------------- correct but convention-free (taste-off shape)

const SLUGIFY_BASELINE = `import re

def slugify(title):
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
`

const MANIFEST_BASELINE = `def parse_manifest(text):
    items = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, qty, price = line.split(",")
        items.append({"name": name.strip(), "quantity": int(qty), "unit_price_cents": int(price)})
    return items

def total_cents(items):
    return sum(i["quantity"] * i["unit_price_cents"] for i in items)

def load_manifest(path):
    with open(path) as f:
        return parse_manifest(f.read())
`

describe("taste task gates", () => {
  test("slugify reference passes every check", () => {
    const outcome = runGate(task("taste-slugify"), fence(SLUGIFY_REFERENCE))
    expect(outcome.error).toBeUndefined()
    expect(outcome.passed).toBe(7)
  })

  test("manifest reference passes every check", () => {
    const outcome = runGate(task("taste-manifest"), fence(MANIFEST_REFERENCE))
    expect(outcome.error).toBeUndefined()
    expect(outcome.passed).toBe(8)
  })

  test("convention-free slugify passes correctness, fails exactly the style checks", () => {
    const outcome = runGate(task("taste-slugify"), fence(SLUGIFY_BASELINE))
    expect(outcome.error).toBeUndefined()
    expect(outcome.passed).toBe(3)
    const failed = outcome.failures.map((f) => f.split(":")[0])
    expect(failed.sort()).toEqual([
      "style-all",
      "style-annotations",
      "style-docstrings",
      "style-valueerror"
    ])
  })

  test("convention-free manifest passes correctness, fails exactly the style checks", () => {
    const outcome = runGate(task("taste-manifest"), fence(MANIFEST_BASELINE))
    expect(outcome.error).toBeUndefined()
    expect(outcome.passed).toBe(4)
    const failed = outcome.failures.map((f) => f.split(":")[0])
    expect(failed.sort()).toEqual([
      "style-annotations",
      "style-dataclass",
      "style-pathlib",
      "style-valueerror"
    ])
  })
})

describe("taste block sync with production", () => {
  test("bench renderer is byte-identical to the harness extension's", () => {
    const samples: Array<[readonly string[], number]> = [
      [GENERIC_TASTE_RULES, TASTE_INJECT_CHARS],
      [task("taste-slugify").tasteRules ?? [], TASTE_INJECT_CHARS],
      [["one rule"], 50],
      [[], 2000]
    ]
    for (const [rules, budget] of samples) {
      expect(renderTasteBlock(rules, budget)).toBe(harnessRenderTasteBlock(rules, budget))
    }
  })

  test("generic regression block fits the shipped budget with every rule included", () => {
    const block = renderTasteBlock(GENERIC_TASTE_RULES, TASTE_INJECT_CHARS)
    for (const rule of GENERIC_TASTE_RULES) expect(block).toContain(rule)
  })
})
