import { Data, Effect } from "effect"

export class ShellError extends Data.TaggedError("ShellError")<{
  readonly cmd: string
  readonly code: number | null
  readonly stderr: string
}> {
  override get message(): string {
    return `command failed (${this.code}): ${this.cmd}\n${this.stderr.trim()}`
  }
}

export interface ShellResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface ShellOptions {
  readonly env?: Record<string, string>
  readonly cwd?: string
}

/** Run a command, capturing output. Never fails the Effect — inspect `code`. */
export const run = (cmd: readonly string[], opts: ShellOptions = {}): Effect.Effect<ShellResult> =>
  Effect.promise(async () => {
    const proc = Bun.spawn([...cmd], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {})
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])
    return { code, stdout, stderr }
  })

/** Run a command, failing with ShellError on non-zero exit. Resolves to stdout. */
export const runOk = (
  cmd: readonly string[],
  opts: ShellOptions = {}
): Effect.Effect<string, ShellError> =>
  run(cmd, opts).pipe(
    Effect.filterOrFail(
      (r) => r.code === 0,
      (r) => new ShellError({ cmd: cmd.join(" "), code: r.code, stderr: r.stderr })
    ),
    Effect.map((r) => r.stdout)
  )

/**
 * Run a long-lived command with stdio wired to this process (journal-friendly).
 * Resolves with the exit code once the process terminates.
 */
export const runInherit = (
  cmd: readonly string[],
  opts: ShellOptions = {}
): Effect.Effect<number> =>
  Effect.promise(async () => {
    const proc = Bun.spawn([...cmd], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env: { ...process.env, ...opts.env },
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {})
    })
    return await proc.exited
  })
