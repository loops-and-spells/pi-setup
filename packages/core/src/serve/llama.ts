import * as fs from "node:fs"
import * as path from "node:path"
import { Effect } from "effect"
import { paths } from "../paths"

const PORT = 8080
const BASE = `http://127.0.0.1:${PORT}`

const findModel = (): string | null => {
  const dir = paths.llama.ggufDir
  if (!fs.existsSync(dir)) return null
  // recursive: split GGUFs live in a subdirectory (DeepSeek-V4-Flash-MXFP4/…)
  const files = (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".gguf"))
    .sort()
  const first = files.find((f) => /00001-of-/.test(f)) ?? files[0]
  return first !== undefined ? path.join(dir, first) : null
}

const serverReady = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

/** Restore slot KV from tmpfs once the server is up (skips reprefill). */
const restoreSlots = async (): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (await serverReady()) break
    await Bun.sleep(1000)
  }
  if (!(await serverReady())) {
    console.error("llama-server not ready in time, skipping slot restore")
    return
  }
  for (const file of fs.readdirSync(paths.llama.slotDir)) {
    if (!file.endsWith(".session")) continue
    const slotId = file.replace(/^slot_/, "").replace(/\.session$/, "")
    console.log(`Restoring slot ${slotId} from ${file}`)
    await fetch(`${BASE}/slots?action=restore&id_slot=${slotId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file })
    }).catch(() => undefined)
  }
}

/** Persist active slots so the next start can skip reprefill. */
const saveSlots = async (): Promise<void> => {
  for (const slot of [0, 1, 2, 3]) {
    await fetch(`${BASE}/slots?action=save&id_slot=${slot}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: `slot_${slot}.session` }),
      signal: AbortSignal.timeout(20000)
    }).catch(() => undefined)
  }
}

/**
 * Foreground llama-server runner (invoked by llama-v4.service).
 *
 * Ported from legacy/llama-v4-serve.sh, including its tuning rationale:
 *  - NCMOE: offload MoE expert tensors of the first N of 43 layers to CPU to
 *    free VRAM headroom for compute buffers / concurrent subagent slots.
 *  - TS: NCMOE frees VRAM only on GPU0 (where the early layers sit), so the
 *    tensor split rebalances free VRAM per card (52,48 pairs with NCMOE=4).
 *  - Slot KV persists to tmpfs; --cache-reuse is unsupported by DeepSeek4's
 *    MLA/hybrid KV, so it is omitted.
 *
 * The systemd unit uses KillMode=mixed so SIGTERM reaches only this process;
 * we save slots over HTTP while the server is still alive, then stop it.
 */
export const serveLlama = (): Effect.Effect<number> =>
  Effect.promise(async () => {
    const model = findModel()
    if (model === null || !fs.existsSync(paths.llama.bin)) {
      console.error(`Missing model (${model}) or binary (${paths.llama.bin})`)
      return 1
    }

    const ncmoe = process.env["NCMOE"] ?? "4"
    const tensorSplit = process.env["TS"] ?? "52,48"
    fs.mkdirSync(paths.llama.slotDir, { recursive: true })

    const proc = Bun.spawn(
      [
        paths.llama.bin,
        "-m", model,
        "--alias", "deepseek-v4-flash",
        "--host", "127.0.0.1",
        "--port", String(PORT),
        "-ngl", "999",
        "--tensor-split", tensorSplit,
        "-t", "24",
        "-tb", "24",
        "-fit", "off",
        "--cache-prompt",
        "--n-cpu-moe", ncmoe,
        "--slot-save-path", paths.llama.slotDir,
        "-c", "262144"
      ],
      {
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...process.env,
          PATH: `${paths.cudaBin}:${process.env["PATH"] ?? ""}`,
          LD_LIBRARY_PATH: `${paths.cudaLib}:${process.env["LD_LIBRARY_PATH"] ?? ""}`
        }
      }
    )

    let stopping = false
    const shutdown = async (signal: NodeJS.Signals) => {
      if (stopping) return
      stopping = true
      console.log(`Received ${signal}: saving slots before stopping llama-server…`)
      await saveSlots()
      proc.kill("SIGTERM")
    }
    process.on("SIGTERM", () => void shutdown("SIGTERM"))
    process.on("SIGINT", () => void shutdown("SIGINT"))

    void restoreSlots()

    return await proc.exited
  })
