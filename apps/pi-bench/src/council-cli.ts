import { Command } from "@effect/cli"
import { Console, Effect } from "effect"
import { gpu, pi, stopAll } from "@pi-setup/core"
import { councilMembers, startCouncil, stopCouncil } from "./council"

const providerId = (memberId: string): string => `council-${memberId.replace(/[^a-z0-9.-]/gi, "")}`

const memberProvider = (m: (typeof councilMembers)[number]): pi.PiProvider => ({
  name: `Council: ${m.id} (llama-server :${m.port}, up only while the council serves)`,
  baseUrl: `http://localhost:${m.port}/v1`,
  api: "openai-completions",
  apiKey: "EMPTY",
  compat: { supportsDeveloperRole: false },
  models: [
    {
      id: m.alias,
      name: `${m.id} — council ${m.role}`,
      contextWindow: m.ctx,
      maxTokens: 32768
    }
  ]
})

/** Add every council member to ~/.pi/agent/models.json (idempotent). */
export const registerProviders = (): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const m of councilMembers) {
      yield* pi.ensureProvider(providerId(m.id), memberProvider(m))
    }
    yield* Console.log(
      "Council providers registered. They answer only while the council is serving\n" +
        "(pi-bench council up). pi's default provider is left untouched."
    )
  })

const upCommand = Command.make("up", {}, () =>
  Effect.gen(function* () {
    yield* registerProviders()
    yield* Console.log("Stopping engines to free VRAM (pi's default engine will be down)…")
    yield* stopAll({ includeLmStudio: false })
    yield* gpu.waitVramFree()
    const handle = yield* startCouncil()
    yield* Console.log(
      "\nCouncil is serving. Consult from pi by switching model to a council-* provider.\n" +
        "Ctrl-C stops the members; then restore pi with: pi-engine use vllm"
    )
    yield* Effect.async<void>((resume) => {
      const stop = (): void => {
        Effect.runPromise(stopCouncil(handle)).finally(() => resume(Effect.void))
      }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
    yield* Console.log("Council stopped. Restore pi's engine with: pi-engine use vllm")
  })
).pipe(Command.withDescription("Serve all council members for pi consultation (foreground)"))

const registerCommand = Command.make("register", {}, () => registerProviders()).pipe(
  Command.withDescription("Register council members as pi providers without starting them")
)

export const councilCommand = Command.make("council").pipe(
  Command.withDescription("Serve or register the council members for pi consultation"),
  Command.withSubcommands([upCommand, registerCommand])
)
