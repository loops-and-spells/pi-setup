import * as fs from "node:fs"
import { Command } from "@effect/cli"
import { docker, engineIds, engines, gpu, p2pStatus, paths, systemd } from "@pi-setup/core"
import { Console, Effect } from "effect"

interface Check {
  readonly label: string
  readonly ok: boolean
  readonly hint?: string
}

const fileCheck = (label: string, path: string, hint?: string): Check => ({
  label: `${label}: ${path}`,
  ok: fs.existsSync(path),
  ...(hint !== undefined ? { hint } : {})
})

export const doctorCommand = Command.make("doctor", {}, () =>
  Effect.gen(function* () {
    const checks: Check[] = []

    checks.push(fileCheck("llama-server binary", paths.llama.bin))
    checks.push(
      fileCheck("llama GGUF dir", paths.llama.ggufDir, "expected DeepSeek-V4-Flash-GGUF download")
    )
    checks.push(
      fileCheck(
        "vLLM model dir",
        `${paths.vllm.modelDir}/config.json`,
        `hf download deepseek-ai/DeepSeek-V4-Flash-DSpark --local-dir ${paths.vllm.modelDir}`
      )
    )
    const vllmImage = yield* docker.imageExists(paths.vllm.image)
    checks.push({
      label: `vLLM Docker image: ${paths.vllm.image}`,
      ok: vllmImage,
      hint: `docker pull ${paths.vllm.image}`
    })
    checks.push(fileCheck("ds4-server binary", `${paths.ds4.dir}/ds4-server`, "pi-engine setup ds4"))
    checks.push(fileCheck("ds4 model", paths.ds4.model, "pi-engine setup ds4"))
    checks.push(fileCheck("pi settings", paths.pi.settings))
    checks.push(fileCheck("pi models", paths.pi.models))

    for (const id of engineIds) {
      const unit = engines[id].unit
      checks.push({
        label: `systemd unit: ${unit}`,
        ok: systemd.unitInstalled(unit),
        hint: "pi-engine install"
      })
    }

    const gpus = yield* gpu.query()
    checks.push({
      label: `GPUs visible via nvidia-smi (${gpus.length} found)`,
      ok: gpus.length > 0
    })
    checks.push({ label: `PCIe P2P: ${p2pStatus()}`, ok: true })

    let failures = 0
    for (const c of checks) {
      if (c.ok) {
        yield* Console.log(`  ✓ ${c.label}`)
      } else {
        failures += 1
        yield* Console.log(`  ✗ ${c.label}${c.hint !== undefined ? `\n      → ${c.hint}` : ""}`)
      }
    }

    yield* Console.log(
      failures === 0
        ? "\n✅ all checks passed"
        : `\n⚠ ${failures} check(s) failed — engines with missing pieces can't be started`
    )
  })
).pipe(Command.withDescription("Check binaries, models, images, units, and pi config"))
