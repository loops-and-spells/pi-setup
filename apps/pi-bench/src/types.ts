export interface HardConstraints {
  /** Substrings the answer must contain verbatim. */
  readonly requiredStrings?: readonly string[]
  /**
   * Execute the deliverable: the largest fenced python block is the
   * interpreter; remaining fenced blocks are treated as (program, expected
   * output) pairs and run through it. Mismatches become violations.
   */
  readonly execExamples?: boolean
  /** Word-count bounds, counted before `beforeMarker` with `stripPatterns` regexes removed. */
  readonly wordRange?: {
    readonly min: number
    readonly max: number
    readonly beforeMarker?: string
    readonly stripPatterns?: readonly string[]
  }
}

export interface TaskGate {
  /**
   * Python source of the hidden tests. Never sent to any model. Runs in a
   * tmpdir beside the extracted solution (and repoContext files, if any); a
   * `check(name, fn)` helper is prepended, so each check prints
   * `CHECK <name>: PASS` or `CHECK <name>: FAIL: <detail>`.
   */
  readonly tests: string
  /** Number of check() calls in `tests` — keeps the score denominator stable even when the solution fails to import. */
  readonly totalChecks: number
  readonly timeoutSec?: number
}

export interface RepoContext {
  /** Mini codebase the task lives in; key = path relative to the repo root. */
  readonly files: Readonly<Record<string, string>>
  /** The file the deliverable replaces; hidden tests import it by this name. */
  readonly target: string
}

export interface BenchTask {
  readonly id: string
  readonly title: string
  readonly temperature: number
  readonly maxTokens: number
  readonly prompt: string
  /** Rubric and answer key for the judge. Never sent to any model under test. */
  readonly judgeNotes: string
  /** Machine-checkable constraints enforced in code before the LLM checker. */
  readonly hardConstraints?: HardConstraints
  /** Executable hidden tests: gated tasks are scored objectively, no judge. */
  readonly gate?: TaskGate
  /**
   * Learned-preference rules for the taste A/B: only the taste-on config sees
   * them (injected as a system message); hidden style-* checks verify them.
   */
  readonly tasteRules?: readonly string[]
  /** Multi-file setting for the context experiments (ctx-none/map/full). */
  readonly repoContext?: RepoContext
  /** Set by the loader when repoContext exists: the prompt WITHOUT the rendered files. */
  readonly rawPrompt?: string
}

export interface GateOutcome {
  readonly passed: number
  readonly total: number
  /** FAIL lines and harness errors, verbatim — fed back in verify-loop revisions. */
  readonly failures: readonly string[]
  /** Set when the gate could not run the solution at all (no code block, import crash, timeout). */
  readonly error?: string
}

export interface ChatMetrics {
  readonly wallMs: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly tokensPerSec: number
}

export interface ChatResult {
  readonly content: string
  readonly reasoning: string
  readonly metrics: ChatMetrics
}

export interface StageResult {
  readonly stage: string
  readonly metrics: ChatMetrics
  readonly content: string
}

export interface TaskResult {
  readonly taskId: string
  readonly configId: string
  readonly output: string
  readonly reasoning: string
  /** Sum of wall time the user actually waits (council: max(advisors) + synthesis). */
  readonly wallMs: number
  readonly completionTokens: number
  readonly stages: readonly StageResult[]
  /** Objective score from the task's hidden gate tests, when the task has one. */
  readonly gate?: GateOutcome
  readonly error?: string
}

export interface RunManifest {
  readonly runId: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly configs: readonly string[]
  readonly tasks: readonly string[]
  readonly results: readonly TaskResult[]
}
