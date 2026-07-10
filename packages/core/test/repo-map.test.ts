import { describe, expect, test } from "bun:test"
import {
  buildSymbolMap,
  fileSymbols,
  fitToBudget,
  pySymbols,
  selectMapFiles
} from "../src/repo-map"

describe("python via tree-sitter", () => {
  test("signatures with docstrings, methods included, bodies omitted", async () => {
    const src = [
      "import os",
      "",
      "class Ledger:",
      '    """Tracks balances in integer cents."""',
      "",
      "    def add(self, amount: int) -> None:",
      '        """Add amount; negative amounts raise ValueError."""',
      "        self.total += amount",
      "",
      "def helper(a,",
      "           b):",
      "    def closure():",
      "        return 1",
      "    return a + b"
    ].join("\n")
    const out = await fileSymbols("mod.py", src)
    expect(out[0]).toBe("- `class Ledger:` — Tracks balances in integer cents.")
    expect(out[1]).toBe("- `def add(self, amount: int) -> None:` — Add amount; negative amounts raise ValueError.")
    expect(out[2]).toBe("- `def helper(a, b):`")
    expect(out.join("\n")).not.toContain("closure") // nested functions are noise
    expect(out.join("\n")).not.toContain("self.total")
  })

  test("decorated functions surface", async () => {
    const out = await fileSymbols(
      "d.py",
      "@retry(3)\ndef fetch(url: str) -> bytes:\n    return b''\n"
    )
    expect(out.some((l) => l.includes("def fetch(url: str) -> bytes:"))).toBe(true)
  })
})

describe("typescript via tree-sitter", () => {
  test("exported surface with JSDoc; non-exports skipped when file exports", async () => {
    const src = [
      "import * as fs from 'node:fs'",
      "",
      "/** Parses a config file into key/value pairs. */",
      "export function parseConfig(text: string): Record<string, string> {",
      "  return {}",
      "}",
      "",
      "const internalHelper = (x: number) => x * 2",
      "",
      "export interface User {",
      "  name: string",
      "}",
      "",
      "export const clamp = (n: number, lo: number, hi: number): number =>",
      "  Math.min(hi, Math.max(lo, n))"
    ].join("\n")
    const out = await fileSymbols("util.ts", src)
    const text = out.join("\n")
    expect(text).toContain("`export function parseConfig(text: string): Record<string, string>` — Parses a config file into key/value pairs.")
    expect(text).toContain("export interface User")
    expect(text).toContain("export const clamp = (n: number, lo: number, hi: number): number")
    expect(text).not.toContain("internalHelper")
  })

  test("class methods surface; data consts don't", async () => {
    const src = [
      "export const CONFIG = { a: 1 }",
      "export class Store {",
      "  /** Persist the value. */",
      "  save(key: string, value: string): void {}",
      "}"
    ].join("\n")
    const out = await fileSymbols("store.ts", src)
    const text = out.join("\n")
    expect(text).toContain("export class Store")
    expect(text).toContain("save(key: string, value: string): void")
    expect(text).not.toContain("CONFIG")
  })
})

describe("other grammars", () => {
  test("go functions and types", async () => {
    const src = [
      "package main",
      "",
      "// Add returns a+b in cents.",
      "func Add(a int, b int) int {",
      "\treturn a + b",
      "}",
      "",
      "type Wallet struct {",
      "\tCents int",
      "}"
    ].join("\n")
    const out = await fileSymbols("main.go", src)
    const text = out.join("\n")
    expect(text).toContain("func Add(a int, b int) int")
    expect(text).toContain("Add returns a+b in cents.")
    expect(text).toContain("Wallet")
  })

  test("rust functions", async () => {
    const out = await fileSymbols(
      "lib.rs",
      "/// Doubles the input.\npub fn double(x: i64) -> i64 {\n    x * 2\n}\n"
    )
    expect(out.join("\n")).toContain("pub fn double(x: i64) -> i64")
  })
})

describe("map assembly", () => {
  test("sections per file, symbol-less files omitted", async () => {
    const map = await buildSymbolMap({
      "pkg/mod.py": "def f(x: int) -> int:\n    return x",
      "src/util.ts": "export function g(): void {}",
      "notes.py": "x = 1\n"
    })
    expect(map).toContain("### `pkg/mod.py`\n- `def f(x: int) -> int:`")
    expect(map).toContain("### `src/util.ts`\n- `export function g(): void`")
    expect(map).not.toContain("notes.py")
  })

  test("selectMapFiles: mappable only, shallow-first, capped, .d.ts excluded", () => {
    const files = ["deep/nested/dir/z.py", "a.ts", "types.d.ts", "img/logo.png", "b.go", "src/c.tsx"]
    expect(selectMapFiles(files, 3)).toEqual(["a.ts", "b.go", "src/c.tsx"])
  })

  test("fitToBudget keeps whole sections and reports the drop", () => {
    const map = ["### `a.py`", "- `def a():`", "", "### `b.py`", "- `def b():`", ""].join("\n")
    const fitted = fitToBudget(map, 30)
    expect(fitted).toContain("### `a.py`")
    expect(fitted).not.toContain("### `b.py`")
    expect(fitted).toContain("1 more file(s) not shown")
    expect(fitToBudget(map, 10000)).toBe(map)
  })

  test("regex fallback stays available and measured-shape", () => {
    expect(pySymbols("def f(x: int) -> int:\n    return x")).toEqual(["- `def f(x: int) -> int:`"])
  })
})
