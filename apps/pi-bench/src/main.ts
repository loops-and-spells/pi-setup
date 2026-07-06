import * as path from "node:path"
import { Command, Options } from "@effect/cli"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import { Console, Effect } from "effect"
import { benchConfigs, configIds, type BenchConfigId } from "./configs"
import { councilCommand } from "./council-cli"
import { writeReports } from "./report"
import { runBench } from "./runner"
import { loadTasks } from "./tasks"
import type { RunManifest } from "./types"

const csv = (s: string): string[] =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)

const configsOpt = Options.text("configs").pipe(
  Options.withDefault(configIds.join(",")),
  Options.withDescription(`comma-separated configs (default: ${configIds.join(",")})`)
)

const tasksOpt = Options.text("tasks").pipe(
  Options.withDefault(""),
  Options.withDescription("comma-separated task ids (default: all)")
)

const outOpt = Options.text("out").pipe(
  Options.withDefault(""),
  Options.withDescription("output dir (default: apps/pi-bench/results/<timestamp>)")
)

const runCommand = Command.make(
  "run",
  { configs: configsOpt, tasks: tasksOpt, out: outOpt },
  (opts) =>
    Effect.gen(function* () {
      const wanted = csv(opts.configs)
      const unknown = wanted.filter((c) => !configIds.includes(c as BenchConfigId))
      if (unknown.length > 0) {
        return yield* Effect.fail(new Error(`unknown configs: ${unknown.join(", ")}`))
      }
      const configs = benchConfigs.filter((c) => wanted.includes(c.id))
      const tasks = loadTasks(csv(opts.tasks))
      const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      const outDir =
        opts.out !== "" ? opts.out : path.resolve(import.meta.dir, "../results", runId)

      yield* Console.log(`Run ${runId}`)
      yield* Console.log(`  configs: ${configs.map((c) => c.id).join(", ")}`)
      yield* Console.log(`  tasks:   ${tasks.map((t) => t.id).join(", ")}`)

      const startedAt = new Date().toISOString()
      const results = yield* runBench(configs, tasks)
      const manifest: RunManifest = {
        runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        configs: configs.map((c) => c.id),
        tasks: tasks.map((t) => t.id),
        results
      }
      writeReports(outDir, manifest, tasks)
      const failures = results.filter((r) => r.error !== undefined)
      yield* Console.log(`\n✅ ${results.length - failures.length}/${results.length} results in ${outDir}`)
      if (failures.length > 0) {
        for (const f of failures) yield* Console.error(`  ✗ ${f.configId}/${f.taskId}: ${f.error}`)
      }
      yield* Console.log("Judge with: read judge-pack.md, score, then unblind via mapping.json")
    })
).pipe(Command.withDescription("Run the benchmark across configurations and write reports"))

const packCommand = Command.make(
  "pack",
  {
    dir: Options.text("dir").pipe(Options.withDescription("existing run directory (contains run.json)"))
  },
  ({ dir }) =>
    Effect.gen(function* () {
      const manifest = (yield* Effect.promise(() =>
        Bun.file(path.join(dir, "run.json")).json()
      )) as RunManifest
      const tasks = loadTasks(manifest.tasks)
      writeReports(dir, manifest, tasks)
      yield* Console.log(`Regenerated reports in ${dir}`)
    })
).pipe(Command.withDescription("Regenerate metrics/judge-pack/mapping for an existing run"))

const root = Command.make("pi-bench").pipe(
  Command.withDescription(
    "Benchmark harness: single engines vs Mix-of-Models council, with a blind judge pack"
  ),
  Command.withSubcommands([runCommand, packCommand, councilCommand])
)

const cli = Command.run(root, { name: "pi-bench", version: "0.1.0" })

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain)
