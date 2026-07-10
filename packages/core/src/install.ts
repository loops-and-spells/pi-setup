import * as fs from "node:fs"
import * as path from "node:path"
import { Console, Effect } from "effect"
import { engineIds, engines } from "./engines"
import { paths } from "./paths"
import * as pi from "./pi-config"
import * as systemd from "./systemd"

const cliEntry = path.join(paths.repoRoot, "apps/pi-engine/src/main.ts")

/** The real bun binary (mise shims don't survive systemd's bare environment). */
const bunBin = process.execPath

const serveExec = (engine: string) => `${bunBin} run ${cliEntry} serve ${engine}`

const otherUnits = (self: string): string =>
  engineIds
    .map((id) => engines[id].unit)
    .filter((u) => u !== self)
    .join(" ")

// LM Studio was dropped from this machine; keep the hooks conditional so the
// generated units stay valid whether or not it is present.
const hasLmStudio = fs.existsSync(paths.lms)
const lmsConflict = hasLmStudio ? "lmstudio.service " : ""
const lmsExecStartPre = hasLmStudio
  ? `# Free ALL LM Studio VRAM before starting (daemon down unloads every model).
ExecStartPre=-${paths.lms} daemon down
ExecStartPre=/usr/bin/sleep 3
`
  : ""

// The standalone scout must not hold VRAM (or port 9107) while a big engine
// allocates; the pi-council extension restarts it afterwards when needed.
const scoutStopPre = `ExecStartPre=-/usr/bin/systemctl --user stop council-scout.service
`

const unitFiles: Record<string, string> = {
  "llama-v4.service": `[Unit]
Description=DeepSeek V4-Flash via llama-server (pi-engine suite)
# Mutual exclusion at the systemd level: starting this stops the others.
Conflicts=${lmsConflict}${otherUnits("llama-v4.service")}
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
${lmsExecStartPre}${scoutStopPre}ExecStart=${serveExec("llama")}
Restart=on-failure
RestartSec=5
TimeoutStartSec=900
# SIGTERM goes to the bun wrapper only, which saves slot KV over HTTP while
# llama-server is still alive, then stops it. SIGKILL to the rest on timeout.
KillMode=mixed
TimeoutStopSec=120

[Install]
WantedBy=default.target
`,

  "vllm-dspark.service": `[Unit]
Description=DeepSeek V4-Flash-DSpark via vLLM + Docker (pi-engine suite)
Conflicts=${lmsConflict}${otherUnits("vllm-dspark.service")}
After=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=3

[Service]
Type=simple
ExecStartPre=-/usr/bin/docker rm -f ${paths.vllm.container}
${scoutStopPre}ExecStart=${serveExec("vllm")}
# The container detaches from the unit cgroup; make sure it dies with the unit.
ExecStopPost=-/usr/bin/docker rm -f ${paths.vllm.container}
Restart=on-failure
RestartSec=10
TimeoutStartSec=1800
TimeoutStopSec=60

[Install]
WantedBy=default.target
`,

  "ds4.service": `[Unit]
Description=DeepSeek V4-Flash via DwarfStar ds4 (pi-engine suite)
Conflicts=${lmsConflict}${otherUnits("ds4.service")}
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
# The 91GB q2-q4 GGUF exceeds one card's arena (~96GB of tensor spans), and
# ds4 has no multi-GPU — SSD streaming is required. Pin to GPU1 (GPU0 hosts
# the desktop); llama uses both GPUs, so keep this scoped to the unit only.
Environment=CUDA_VISIBLE_DEVICES=1
Environment=DS4_SSD_STREAMING=1
Environment=DS4_CTX=100000
Environment="DS4_EXTRA_ARGS=--ssd-streaming-cache-experts 64GB"
${lmsExecStartPre}${scoutStopPre}ExecStart=${serveExec("ds4")}
Restart=on-failure
RestartSec=5
TimeoutStartSec=900
TimeoutStopSec=60

[Install]
WantedBy=default.target
`,

  "ornith-council.service": `[Unit]
Description=Ornith Council — Ornith-397B + Qwen3-4B scout behind an OpenAI proxy (pi-engine suite)
Conflicts=${lmsConflict}${otherUnits("ornith-council.service")}
After=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=3

[Service]
Type=simple
${lmsExecStartPre}${scoutStopPre}ExecStart=${serveExec("council")}
Restart=on-failure
RestartSec=10
# Ornith is 166GB from NVMe on a cold start
TimeoutStartSec=1800
TimeoutStopSec=120

[Install]
WantedBy=default.target
`,

  "council-scout.service": `[Unit]
Description=Qwen3-4B council scout — 2.3GB advisor/checker for the pi-council extension
# No Conflicts on purpose: the scout co-exists with every engine. Engines stop
# it before allocating VRAM (ExecStartPre) and the extension restarts it after.
After=network-online.target

[Service]
Type=simple
Environment=CUDA_VISIBLE_DEVICES=1
Environment=LD_LIBRARY_PATH=${paths.cudaLib}
ExecStart=${paths.llama.bin} -m ${paths.council.scoutGguf} --alias qwen3-4b --host 127.0.0.1 --port 9107 -ngl 999 -c 32768 --jinja --reasoning-budget 1024
Restart=on-failure
RestartSec=5
TimeoutStartSec=300
TimeoutStopSec=30

[Install]
WantedBy=default.target
`
}

const timestamp = (): string => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)

const writeWithBackup = (file: string, content: string): "written" | "unchanged" => {
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, "utf8")
    if (current === content) return "unchanged"
    fs.copyFileSync(file, `${file}.bak-${timestamp()}`)
  }
  fs.writeFileSync(file, content)
  return "written"
}

const shim = `#!/usr/bin/env bash
# Generated by pi-engine install — do not edit (edit ${paths.repoRoot} instead).
exec "${bunBin}" run "${cliEntry}" "$@"
`

/**
 * switch-engine compatibility wrapper: old muscle memory keeps working while
 * everything routes through the new CLI.
 */
const compatShim = `#!/usr/bin/env bash
# Generated by pi-engine install — legacy switch-engine interface.
case "\${1:-status}" in
  llama|llama.cpp) exec pi-engine use llama ;;
  vllm|vllm-dspark|dspark) exec pi-engine use vllm ;;
  ds4|dwarfstar) exec pi-engine use ds4 ;;
  council|ornith|ornith-council) exec pi-engine use council ;;
  status|--status|-s) exec pi-engine status ;;
  *) echo "switch-engine is now pi-engine — try: pi-engine --help"; exit 1 ;;
esac
`

export const install = (): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    fs.mkdirSync(paths.systemdUserDir, { recursive: true })
    fs.mkdirSync(paths.localBin, { recursive: true })

    for (const [unit, content] of Object.entries(unitFiles)) {
      const result = writeWithBackup(systemd.unitPath(unit), content)
      yield* Console.log(`  ${result === "written" ? "✏" : "="} ${unit} (${result})`)
    }
    yield* systemd.daemonReload().pipe(Effect.mapError((e) => new Error(e.message)))

    const shimPath = path.join(paths.localBin, "pi-engine")
    writeWithBackup(shimPath, shim)
    fs.chmodSync(shimPath, 0o755)
    yield* Console.log(`  ✏ ${shimPath}`)

    const compatPath = path.join(paths.localBin, "switch-engine")
    writeWithBackup(compatPath, compatShim)
    fs.chmodSync(compatPath, 0o755)
    yield* Console.log(`  ✏ ${compatPath} (compat wrapper → pi-engine)`)

    for (const id of engineIds) {
      const eng = engines[id]
      yield* pi.ensureProvider(eng.providerId, eng.provider)
    }

    // the scout answers on :9107 whether served by council-scout.service or
    // by the ornith-council engine — pi-council picks it up either way
    yield* pi.ensureProvider("council-qwen3-4b", {
      name: "Council scout: Qwen3-4B (llama-server :9107)",
      baseUrl: "http://localhost:9107/v1",
      api: "openai-completions",
      apiKey: "EMPTY",
      compat: { supportsDeveloperRole: false },
      models: [
        {
          id: "qwen3-4b",
          name: "Qwen3-4B — council scout/checker",
          contextWindow: 32768,
          maxTokens: 8192
        }
      ]
    })

    yield* Console.log("\n✅ install complete — engines: llama | vllm | ds4 | council")
    yield* Console.log("   next: pi-engine use vllm   (or: pi-engine use council)")
  })
