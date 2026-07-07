/**
 * Code-computable failure signals a council proxy can see WITHOUT ground
 * truth (no tests, no answer keys). These target the measured failure class
 * of local thinking models — token-budget spirals that ship empty, truncated,
 * or codeless answers (see BENCHMARK.md, Harness Techniques Study): the
 * failures independent resampling rescued (0/8 → 8/8 on gate-repo).
 */

export const draftFormatViolations = (request: string, draft: string): string[] => {
  const text = draft.trim()
  if (text.length < 50) {
    return [
      "The answer is empty or degenerately short — likely all budget went to deliberation. " +
        "Produce the complete answer."
    ]
  }
  const violations: string[] = []
  if (((draft.match(/```/g)?.length ?? 0) % 2) === 1) {
    violations.push(
      "The answer ends inside an unclosed code fence — it appears truncated. " +
        "Produce the complete answer."
    )
  }
  const demandsCode = /```|fenced code block|code block/i.test(request)
  if (demandsCode && [...draft.matchAll(/```[a-z]*\n[\s\S]*?```/g)].length === 0) {
    violations.push(
      "The request requires a fenced code block, but the answer contains no complete " +
        "fenced code block."
    )
  }
  return violations
}
