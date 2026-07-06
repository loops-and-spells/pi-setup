import * as path from "node:path"
import { Console, Effect } from "effect"
import { paths } from "./paths"
import { readState, statePath, writeState } from "./state"

const PROBE_CONTAINER = "pi-engine-p2p-probe"
const PROBE_TIMEOUT_MS = 120_000

export type P2pResult = "pass" | "hang" | "fail"

/**
 * Run a real 2-GPU NCCL allreduce with P2P forced ON (the configuration that
 * hangs when PCIe P2P is broken, e.g. under the AMD IOMMU without iommu=pt).
 * Uses the vLLM image as the CUDA+torch environment. The verdict is persisted
 * so `serve vllm` can pick the fast path automatically.
 */
export const probeP2p = (): Effect.Effect<P2pResult> =>
  Effect.gen(function* () {
    const testScript = path.join(paths.repoRoot, "scripts/nccl-p2p-test.py")
    yield* Console.log("Probing PCIe P2P with a 2-GPU NCCL allreduce (P2P forced ON)…")
    yield* Console.log(`  image: ${paths.vllm.image}, timeout: ${PROBE_TIMEOUT_MS / 1000}s`)

    Bun.spawnSync(["docker", "rm", "-f", PROBE_CONTAINER], { stdout: "ignore", stderr: "ignore" })

    const result = yield* Effect.promise(async (): Promise<P2pResult> => {
      const proc = Bun.spawn(
        [
          "docker", "run", "--rm",
          "--name", PROBE_CONTAINER,
          "--gpus", "all",
          "--ipc=host", "--network", "host",
          "-v", `${testScript}:/test.py:ro`,
          "-e", "NCCL_P2P_DISABLE=0",
          "-e", "NCCL_IB_DISABLE=1",
          "-e", "NCCL_SOCKET_IFNAME=lo",
          "--entrypoint", "python3",
          paths.vllm.image,
          "/test.py"
        ],
        { stdout: "pipe", stderr: "pipe" }
      )

      const timer = setTimeout(() => {
        // a hang IS the diagnostic result — kill the spinning container
        Bun.spawnSync(["docker", "rm", "-f", PROBE_CONTAINER], {
          stdout: "ignore",
          stderr: "ignore"
        })
        proc.kill()
      }, PROBE_TIMEOUT_MS)

      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      clearTimeout(timer)

      if (stdout.includes("NCCL_ALLREDUCE_PASS")) return "pass"
      return code === 0 ? "fail" : "hang"
    })

    const verdicts: Record<P2pResult, string> = {
      pass: "✅ P2P works — vLLM will use NCCL P2P + custom allreduce on next start",
      hang: "⛔ P2P hangs (allreduce pinned until timeout) — vLLM stays on the shared-memory path",
      fail: "⚠ probe errored without passing — treating P2P as broken"
    }
    writeState({ p2pWorks: result === "pass", p2pTestedAt: new Date().toISOString() })
    yield* Console.log(verdicts[result])
    yield* Console.log(`  state saved: ${statePath()}`)
    if (result === "pass") {
      yield* Console.log("  apply with: pi-engine use vllm   (restarts into the fast path)")
    }
    return result
  })

/** Current probe verdict for display (doctor/status). */
export const p2pStatus = (): string => {
  const s = readState()
  if (s.p2pWorks === undefined) return "unprobed (run: pi-engine probe p2p)"
  return `${s.p2pWorks ? "working (fast path enabled)" : "broken (SHM fallback)"} — tested ${s.p2pTestedAt ?? "?"}`
}
