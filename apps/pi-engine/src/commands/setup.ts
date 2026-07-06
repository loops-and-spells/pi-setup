import * as fs from "node:fs"
import * as path from "node:path"
import { Command, Options } from "@effect/cli"
import { paths, runInherit, runOk } from "@pi-setup/core"
import { Console, Data, Effect } from "effect"

class SetupError extends Data.TaggedError("SetupError")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason
  }
}

/**
 * Model variant guidance for this machine (125GB system RAM, 2×96GB VRAM,
 * ds4 has no single-node multi-GPU):
 *  - q2-q4-imatrix: best default — 2-bit with last 6 layers 4-bit, sized for
 *    the 96/128GB class. Maximum quality that fits without streaming.
 *  - q4-imatrix: nominally wants ≥256GB; only viable here with
 *    DS4_SSD_STREAMING=1 (routed experts cached in RAM, loaded from SSD on miss).
 *  - q2-imatrix: smallest/fastest fallback.
 *  - pro-q2-imatrix: DeepSeek V4 PRO, sized for 512GB machines — on this box
 *    only via DS4_SSD_STREAMING=1; upstream calls the 128GB-class streaming
 *    path "experimental but usable … when you accept slow generation".
 */
const variantOpt = Options.choice("variant", [
  "q2-imatrix",
  "q2-q4-imatrix",
  "q4-imatrix",
  "pro-q2-imatrix"
]).pipe(
  Options.withDefault("q2-q4-imatrix" as const),
  Options.withDescription("GGUF quant from antirez/deepseek-v4-gguf (default: q2-q4-imatrix)")
)

const cudaArchOpt = Options.text("cuda-arch").pipe(
  Options.withDefault(""),
  Options.withDescription("Override CUDA arch (e.g. sm_120, native). Default: make cuda-generic")
)

const skipDownloadOpt = Options.boolean("skip-download").pipe(
  Options.withDescription("Clone and build only; skip the model download")
)

const withMtpOpt = Options.boolean("with-mtp").pipe(
  Options.withDescription(
    "Also download the optional MTP draft GGUF (ds4's DSpark-style speculative path; enable via DS4_MTP=auto)"
  )
)

const setupDs4 = Command.make(
  "ds4",
  { variant: variantOpt, cudaArch: cudaArchOpt, skipDownload: skipDownloadOpt, withMtp: withMtpOpt },
  ({ variant, cudaArch, skipDownload, withMtp }) =>
    Effect.gen(function* () {
      const dir = paths.ds4.dir

      if (!fs.existsSync(dir)) {
        yield* Console.log(`Cloning ${paths.ds4.repo} → ${dir}`)
        yield* runOk(["git", "clone", paths.ds4.repo, dir]).pipe(
          Effect.mapError((e) => new SetupError({ reason: e.message }))
        )
      } else {
        yield* Console.log(`Updating ${dir}`)
        yield* runInherit(["git", "-C", dir, "pull", "--ff-only"])
      }

      const makeArgs =
        cudaArch.length > 0 ? ["make", "cuda", `CUDA_ARCH=${cudaArch}`] : ["make", "cuda-generic"]
      // ds4's Makefile defaults CUDA_HOME to /usr/local/cuda; Arch ships /opt/cuda.
      const cudaHome = path.dirname(paths.cudaBin)
      yield* Console.log(`Building: ${makeArgs.join(" ")} (CUDA_HOME=${cudaHome})`)
      const buildCode = yield* runInherit(makeArgs, {
        cwd: dir,
        env: {
          CUDA_HOME: cudaHome,
          PATH: `${paths.cudaBin}:${process.env["PATH"] ?? ""}`
        }
      })
      if (buildCode !== 0) {
        return yield* new SetupError({ reason: `ds4 build failed (exit ${buildCode})` })
      }
      yield* Console.log("✅ ds4 built")

      if (skipDownload) {
        yield* Console.log("Skipping model download (--skip-download)")
      } else if (fs.existsSync(paths.ds4.model)) {
        yield* Console.log(`Model already present: ${fs.realpathSync(paths.ds4.model)}`)
        yield* Console.log(`(re-run with a different --variant to fetch another quant)`)
      } else {
        yield* Console.log(`Downloading ${variant} from antirez/deepseek-v4-gguf (resumable)…`)
        const dlCode = yield* runInherit(["./download_model.sh", variant], { cwd: dir })
        if (dlCode !== 0) {
          return yield* new SetupError({ reason: `model download failed (exit ${dlCode})` })
        }
        yield* Console.log("✅ model downloaded")
      }

      if (withMtp) {
        yield* Console.log("Downloading optional MTP draft GGUF…")
        const mtpCode = yield* runInherit(["./download_model.sh", "mtp"], { cwd: dir })
        if (mtpCode !== 0) {
          yield* Console.error("MTP download failed — continuing (serving works without it)")
        } else {
          yield* Console.log("✅ MTP downloaded — enable with DS4_MTP=auto on ds4.service")
        }
      }

      yield* Console.log("\nNext: pi-engine use ds4")
      if (variant === "q4-imatrix" || variant === "pro-q2-imatrix") {
        yield* Console.log(
          `${variant} exceeds this machine's 125GB RAM — set DS4_SSD_STREAMING=1 ` +
            "(systemctl --user edit ds4.service → [Service] Environment=DS4_SSD_STREAMING=1)"
        )
      }
    })
).pipe(Command.withDescription("Clone, build (CUDA), and download a model for DwarfStar ds4"))

export const setupCommand = Command.make("setup", {}, () =>
  Console.log("Specify what to set up — currently: pi-engine setup ds4")
).pipe(Command.withSubcommands([setupDs4]), Command.withDescription("One-time engine enablement"))
