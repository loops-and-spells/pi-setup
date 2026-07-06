import { Command } from "@effect/cli"
import { probeP2p } from "@pi-setup/core"
import { Console, Effect } from "effect"

const probeP2pCommand = Command.make("p2p", {}, () =>
  Effect.gen(function* () {
    const result = yield* probeP2p()
    if (result !== "pass") {
      yield* Console.log(
        "\nTo attempt a platform fix: add iommu=pt to the kernel cmdline (see README), reboot, re-probe."
      )
    }
  })
).pipe(
  Command.withDescription(
    "Test whether PCIe P2P between the GPUs actually works (NCCL allreduce with P2P on); persists the verdict for serve vllm"
  )
)

export const probeCommand = Command.make("probe", {}, () =>
  Console.log("Specify what to probe — currently: pi-engine probe p2p")
).pipe(Command.withSubcommands([probeP2pCommand]), Command.withDescription("Hardware capability probes"))
