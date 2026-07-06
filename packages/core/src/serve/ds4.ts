import * as fs from "node:fs"
import { Effect } from "effect"
import { paths } from "../paths"

/**
 * Foreground DwarfStar runner (invoked by ds4.service).
 *
 * ds4-server exposes OpenAI- and Anthropic-compatible endpoints. Tunables:
 *  - DS4_PORT (default 8082), DS4_CTX (default 100000)
 *  - DS4_MODEL (default $DS4_DIR/ds4flash.gguf — maintained by download_model.sh)
 *  - DS4_KV_DISK_MB — disk KV cache budget (0 disables --kv-disk-space-mb)
 *  - DS4_SSD_STREAMING=1 — enable SSD streaming for quants larger than RAM
 *    (with 125GB system RAM this is what lets q4-imatrix run at all)
 *  - DS4_MTP — path to the MTP draft GGUF, or "auto" to pick *mtp*.gguf from
 *    the gguf dir. ds4's DSpark-equivalent speculative path: experimental,
 *    greedy-only, slight speedup. Off unless set.
 *  - DS4_MTP_DRAFT — draft tokens per step (default 2)
 *  - DS4_EXTRA_ARGS — appended verbatim (space-separated)
 */
export const serveDs4 = (): Effect.Effect<number> =>
  Effect.promise(async () => {
    const bin = `${paths.ds4.dir}/ds4-server`
    const model = paths.ds4.model
    if (!fs.existsSync(bin) || !fs.existsSync(model)) {
      console.error(`Missing ds4-server (${bin}) or model (${model}).`)
      console.error("Run: pi-engine setup ds4")
      return 1
    }

    const port = process.env["DS4_PORT"] ?? "8082"
    const ctx = process.env["DS4_CTX"] ?? "100000"
    const kvDiskMb = process.env["DS4_KV_DISK_MB"] ?? ""
    fs.mkdirSync(paths.ds4.kvDir, { recursive: true })

    const args = [
      bin,
      "-m", model,
      "--cuda",
      "--host", "127.0.0.1",
      "--port", port,
      "--ctx", ctx,
      "--kv-disk-dir", paths.ds4.kvDir
    ]
    if (kvDiskMb !== "" && kvDiskMb !== "0") args.push("--kv-disk-space-mb", kvDiskMb)
    if (process.env["DS4_SSD_STREAMING"] === "1") args.push("--ssd-streaming")

    const mtp = process.env["DS4_MTP"] ?? ""
    if (mtp !== "" && mtp !== "off") {
      const mtpPath =
        mtp === "auto"
          ? fs
              .readdirSync(`${paths.ds4.dir}/gguf`)
              .filter((f) => /mtp/i.test(f) && f.endsWith(".gguf"))
              .map((f) => `${paths.ds4.dir}/gguf/${f}`)[0]
          : mtp
      if (mtpPath !== undefined && fs.existsSync(mtpPath)) {
        args.push("--mtp", mtpPath, "--mtp-draft", process.env["DS4_MTP_DRAFT"] ?? "2")
        console.log(`MTP speculative decoding enabled: ${mtpPath}`)
      } else {
        console.error(`DS4_MTP set but no MTP GGUF found (${mtp}) — continuing without it`)
      }
    }
    const extra = (process.env["DS4_EXTRA_ARGS"] ?? "").trim()
    if (extra.length > 0) args.push(...extra.split(/\s+/))

    console.log(`Starting ds4-server on port ${port} (ctx ${ctx})…`)
    console.log(`Model: ${fs.realpathSync(model)}`)

    const proc = Bun.spawn(args, {
      stdout: "inherit",
      stderr: "inherit",
      cwd: paths.ds4.dir,
      env: {
        ...process.env,
        PATH: `${paths.cudaBin}:${process.env["PATH"] ?? ""}`,
        LD_LIBRARY_PATH: `${paths.cudaLib}:${process.env["LD_LIBRARY_PATH"] ?? ""}`
      }
    })

    process.on("SIGTERM", () => proc.kill("SIGTERM"))
    process.on("SIGINT", () => proc.kill("SIGINT"))

    return await proc.exited
  })
