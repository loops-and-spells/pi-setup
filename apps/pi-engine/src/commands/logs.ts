import { Command, Options } from "@effect/cli"
import { engines, runInherit, systemd } from "@pi-setup/core"
import { Console, Effect } from "effect"
import { engineArg } from "../args"

const linesOpt = Options.integer("lines").pipe(
  Options.withAlias("n"),
  Options.withDefault(50),
  Options.withDescription("Number of journal lines")
)

const followOpt = Options.boolean("follow").pipe(
  Options.withAlias("f"),
  Options.withDescription("Follow the journal")
)

export const logsCommand = Command.make(
  "logs",
  { engine: engineArg, lines: linesOpt, follow: followOpt },
  ({ engine, lines, follow }) =>
    Effect.gen(function* () {
      const unit = engines[engine].unit
      if (follow) {
        yield* runInherit(["journalctl", "--user", "-u", unit, "-n", String(lines), "-f"])
        return
      }
      const out = yield* systemd.journalTail(unit, lines)
      yield* Console.log(out.length > 0 ? out : `(no journal entries for ${unit})`)
    })
).pipe(Command.withDescription("Show journal logs for an engine"))
