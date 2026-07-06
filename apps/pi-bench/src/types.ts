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
