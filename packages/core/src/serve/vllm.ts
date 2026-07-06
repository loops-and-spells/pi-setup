import * as fs from "node:fs"
import { Effect } from "effect"
import { paths } from "../paths"
import { readState } from "../state"

/**
 * Foreground vLLM + DSpark runner (invoked by vllm-dspark.service).
 *
 * Ported from legacy/vllm-dspark-serve.sh. Uses Fraser Price's RTX Pro 6000
 * Blackwell-optimized image. All tunables keep their env overrides so the
 * (still-broken) experiment can be iterated on without code changes:
 * VLLM_IMAGE, MODEL_DIR, VLLM_PORT, TP_SIZE, GPU_MEM_UTIL, MAX_MODEL_LEN,
 * MAX_NUM_SEQS, DSPARK_TOKENS, VLLM_EXTRA_ENV (comma-separated KEY=VALUE
 * pairs merged into the container environment).
 */
export const serveVllm = (): Effect.Effect<number> =>
  Effect.promise(async () => {
    const image = paths.vllm.image
    const modelDir = paths.vllm.modelDir
    const port = process.env["VLLM_PORT"] ?? "8081"
    const tpSize = process.env["TP_SIZE"] ?? "2"
    // 0.85/262144 never fit: weights + overhead left -1.31GiB for KV. At 0.93
    // there is ~6.2GiB KV per GPU; 131072 ctx needs 3.96GiB, leaving margin
    // for CUDA graphs (the image disables graph memory profiling).
    const gpuMemUtil = process.env["GPU_MEM_UTIL"] ?? "0.93"
    const maxModelLen = process.env["MAX_MODEL_LEN"] ?? "131072"
    const maxNumSeqs = process.env["MAX_NUM_SEQS"] ?? "1"
    // The image has n_predict=4 hardcoded, so num_speculative_tokens must be a
    // multiple of 4. 4 is closest to the model's native dspark_block_size=5.
    const dsparkTokens = process.env["DSPARK_TOKENS"] ?? "4"

    const p2pWorks = readState().p2pWorks === true

    if (!fs.existsSync(`${modelDir}/config.json`)) {
      console.error(`ERROR: Model not found at ${modelDir}`)
      console.error(
        `Download with: hf download deepseek-ai/DeepSeek-V4-Flash-DSpark --local-dir ${modelDir}`
      )
      return 1
    }

    const have = Bun.spawnSync(["docker", "image", "inspect", image], { stdout: "ignore", stderr: "ignore" })
    if (have.exitCode !== 0) {
      console.log(`Pulling Docker image: ${image}`)
      const pull = Bun.spawn(["docker", "pull", image], { stdout: "inherit", stderr: "inherit" })
      if ((await pull.exited) !== 0) return 1
    }

    Bun.spawnSync(["docker", "rm", "-f", paths.vllm.container], { stdout: "ignore", stderr: "ignore" })

    const containerEnv: Record<string, string> = {
      VLLM_USE_B12X_MOE: "1",
      VLLM_USE_B12X_WO_PROJECTION: "1",
      VLLM_DSPARK_CONFIDENCE_SCHEDULER: "off",
      VLLM_DSPARK_LOCAL_ARGMAX: "1",
      VLLM_DSPARK_REPLICATE_MARKOV_W1: "1",
      VLLM_DSPARK_FUSED_MARKOV_ARGMAX: "0",
      VLLM_DSPARK_REFERENCE_KV_QUANT_DEQUANT: "0",
      VLLM_DSV4_B12X_COMPRESSED_MLA: "0",
      VLLM_DSV4_DSPARK_DEFER_TARGET_CAPTURE: "0",
      B12X_W4A16_TC_DECODE: "0",
      // PCIe P2P hangs under the AMD IOMMU unless iommu=pt is on the kernel
      // cmdline (driver reports peer access, transfers pin both GPUs at 100%).
      // `pi-engine probe p2p` measures reality and persists the verdict;
      // p2pWorks=true enables NCCL P2P + custom allreduce (the fast path,
      // ~5-15% decode). Explicit env always wins.
      NCCL_P2P_DISABLE: process.env["NCCL_P2P_DISABLE"] ?? (p2pWorks ? "0" : "1"),
      NCCL_IB_DISABLE: "1",
      NCCL_SOCKET_IFNAME: "lo",
      VLLM_NCCL_SO_PATH: "/opt/libnccl-local-inference.so.2.30.4",
      VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS: "0"
    }
    for (const pair of (process.env["VLLM_EXTRA_ENV"] ?? "").split(",")) {
      const eq = pair.indexOf("=")
      if (eq > 0) containerEnv[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
    }

    console.log(`Starting vLLM + DSpark on port ${port}…`)
    console.log(`Model: ${modelDir}`)
    console.log(`TP: ${tpSize}, GPU mem: ${gpuMemUtil}, max len: ${maxModelLen}`)
    console.log(
      `Inter-GPU path: ${p2pWorks ? "P2P fast path (NCCL P2P + custom allreduce)" : "SHM fallback (P2P broken/unprobed — see: pi-engine probe p2p)"}`
    )

    const args = [
      "docker", "run", "--gpus", "all",
      "--name", paths.vllm.container,
      "--ipc=host",
      "--network", "host",
      "-v", `${modelDir}:/model`,
      "-v", `${paths.vllm.hfCache}:/root/.cache/huggingface`,
      ...Object.entries(containerEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      image,
      "vllm", "serve", "/model",
      // without this, vLLM names the model "/model" and pi's configured id 404s
      "--served-model-name", process.env["VLLM_SERVED_NAME"] ?? "deepseek-v4-flash-dspark",
      "--port", port,
      "--tensor-parallel-size", tpSize,
      "--distributed-executor-backend", "mp",
      // vLLM's custom_allreduce probes can_device_access_peer, which lies when
      // P2P is broken (see NCCL_P2P_DISABLE above) — it would hang
      // independently of NCCL, so it follows the same probe verdict.
      ...((process.env["VLLM_CUSTOM_ALLREDUCE"] ?? (p2pWorks ? "1" : "0")) === "1"
        ? []
        : ["--disable-custom-all-reduce"]),
      "--kv-cache-dtype", "fp8",
      "--block-size", "256",
      "--max-model-len", maxModelLen,
      "--max-num-seqs", maxNumSeqs,
      "--max-num-batched-tokens", "8192",
      "--gpu-memory-utilization", gpuMemUtil,
      "--trust-remote-code",
      "--tokenizer-mode", "deepseek_v4",
      "--reasoning-parser", "deepseek_v4",
      "--speculative-config",
      JSON.stringify({ method: "dspark", num_speculative_tokens: Number(dsparkTokens) })
    ]

    const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" })

    let stopping = false
    const shutdown = (signal: NodeJS.Signals) => {
      if (stopping) return
      stopping = true
      console.log(`Received ${signal}: removing container ${paths.vllm.container}…`)
      Bun.spawnSync(["docker", "rm", "-f", paths.vllm.container], { stdout: "ignore", stderr: "ignore" })
      proc.kill("SIGTERM")
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"))
    process.on("SIGINT", () => shutdown("SIGINT"))

    return await proc.exited
  })
