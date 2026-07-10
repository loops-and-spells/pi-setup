/**
 * Taste A/B support. `renderTasteBlock` is a byte-for-byte copy of the one in
 * harness/extensions/taste.ts — the A/B must measure exactly what production
 * injects. Keep the two in sync (test/taste-sync.test.ts enforces it).
 */
export const renderTasteBlock = (rules: readonly string[], budgetChars: number): string => {
  if (rules.length === 0) return ""
  const header =
    "## Learned user preferences (taste)\n" +
    "Rules learned from this user's past edits to agent-written code. " +
    "Follow them unless the current task explicitly requires otherwise.\n"
  let block = header
  for (const r of rules) {
    const line = `- ${r}\n`
    if (block.length + line.length > budgetChars) break
    block += line
  }
  return block === header ? "" : block.trimEnd()
}

/** Same char budget the extension ships with (taste.json injectChars default). */
export const TASTE_INJECT_CHARS = 1800

/**
 * Regression payload: on tasks WITHOUT their own tasteRules, taste-on injects
 * this realistic learned-preferences block. It is deliberately NEUTRAL to the
 * existing gate-* hidden tests (nothing about mutable defaults, identity
 * comparison, iteration-while-removing, caching, cents math) — any score delta
 * vs taste-off is pure context tax, not a hint.
 */
export const GENERIC_TASTE_RULES: readonly string[] = [
  "Every function must have complete type annotations for all parameters and the return value.",
  "Every public function and class needs a docstring stating its contract.",
  "Use f-strings exclusively; never % formatting or .format().",
  "Use pathlib.Path for filesystem work, never os.path.",
  "Prefer early returns over nested conditionals.",
  "Variables and functions are snake_case; no single-letter names outside comprehensions.",
  "Prefer explicit imports; never wildcard imports.",
  "Comments explain why, not what.",
  "Prefer dataclasses over plain dicts for structured records."
]
