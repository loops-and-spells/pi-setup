import { describe, expect, test } from "bun:test"
import { buildMapFor } from "./repo-map"

/**
 * The extraction logic is tested in packages/core/test/repo-map.test.ts.
 * This exercises the extension's own layer — git discovery + budget wiring —
 * on the real repo, which also proves the harness→core relative import
 * resolves from this file's location (the same resolution pi relies on).
 */
describe("buildMapFor", () => {
  test("maps this repo within budget and finds known symbols", async () => {
    const repo = `${import.meta.dir}/../..`
    const map = await buildMapFor(repo, 6000, 400)
    expect(map.length).toBeGreaterThan(500)
    expect(map.length).toBeLessThanOrEqual(6100) // budget + drop note
    expect(map).toContain("### `")
  })

  test("returns empty outside a git repo", async () => {
    const map = await buildMapFor("/tmp", 6000, 400)
    expect(map).toBe("")
  })
})
