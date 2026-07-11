# harness/

## Purpose

Source of truth for the user's pi harness. Everything here is symlinked into `~/.pi/agent` by `scripts/install-harness.sh` — edit files here, never the copies under `~/.pi/agent`.

## Ownership

- `AGENTS.global.md` — global DOX contract (agent0ai/dox, adapted for global scope); installed as `~/.pi/agent/AGENTS.md`, loaded by pi in every session
- `agents/` — subagent role definitions (planner, reviewer, scout, worker)
- `prompts/` — prompt templates for the subagent extension (vendored from pi's bundled examples)
- `extensions/omarchy-system-theme.ts` — syncs pi theme with omarchy
- `extensions/verify-gate.ts` — after edit turns, runs the AGENTS.md-chain `## Verification` commands and feeds failures back to the model (bounded retries; `/verify` command). The measured biggest quality lever — keep it enabled
- `extensions/taste.ts` — learns user preferences from their edits to agent-written files (snapshot → harvest diff → LLM distill into `~/.pi/agent/taste/rules.md`); injects a capped rule block per turn (`/taste` command). Enabled by measured evidence (pi-bench taste A/B: adherence 2/24 → 17/24, zero regression at the production tier); inert until rules are learned
- `extensions/repo-map.ts` — injects a budget-capped symbol map (signatures + doc contracts) of the cwd repo each turn (`/repomap` command); extraction is `@pi-setup/core`'s tree-sitter builder, shared with pi-bench's ctx-map config. Measured basis: symbol maps recover full-file quality (ctx study). Note this extension imports repo code — the harness must stay symlinked into a repo checkout with `bun install` run
- `extensions/loop-guard.ts` — breaks agentic tool-call repetition loops: `threshold` (3) consecutive byte-identical tool-call turns triggers one steered intervention, bounded per input (`/loopguard` command). Precision-first exact-match detection; regression-tested against the real stuck session it was built from. Covers the turn type the council ladder (non-agentic) and verify-gate (edits) don't
- `extensions/autonomy.ts` — makes the agent act instead of delegating shell work to the user: injects an agency contract into the system prompt each turn, and steers once per input when a turn ends by handing the user a runnable non-privileged command (`/autonomy` command). Detector is precision-first (1 fire / 942 real assistant turns, true positive; sudo/interactive/web-UI hand-offs never trigger), regression-tested against mined real-session deflections
- `extensions/rca.ts` — forces root-cause analysis when one normalized failure signature recurs 3× in failed tool results (session-scoped history — failure loops span user inputs; budget per input): one steered intervention ordering the engineering method (mechanism → differential → ground-truth checks → one change) (`/rca` command). Precision-first (1 fire / 1107 tool results in machine history, the true voxcraft symptom-patching loop), regression-tested against that session. Completes the guard family: loop-guard = identical actions, rca = identical failures under differing actions
- `extensions/unreal.ts` — real clangd intelligence for Unreal Engine projects: at session start in a `*.uproject` + engine-checkout directory, regenerates `compile_commands.json` via UnrealBuildTool `-mode=GenerateClangDatabase` in the background when missing or older than the project's *.uproject/*.Build.cs/*.Target.cs (engine subtree excluded); pi-lens/clangd then resolve engine headers instead of reporting false positives (`/unreal` command). Verified on voxcraft: 38,707-entry database, `clangd --check` on VoxCore = 0 errors
- `extensions/subagent/` — subagent extension (vendored from pi's bundled examples). Delegate for context isolation and parallelism, not quality: same-endpoint role staging (plan→exec, draft→critique→revise) measured ≤+2/38 checks at 1.6–2.3× tokens (BENCHMARK.md delegation study)
- `packages.json` — pi extension packages; merged (never overwritten) into `~/.pi/agent/settings.json` by the installer

## Local Contracts

- `AGENTS.global.md` must stay valid as a *global* file: no project-specific text, and the DOX bootstrap rule (initialize a project tree when missing) replaces upstream's "not yet indexed" section
- The pi-council extension lives in `apps/pi-council`, not here; the installer links it directly
- Adding a file here requires a matching `link` line in `scripts/install-harness.sh`

## Verification

- `bun run test:harness` — extension logic tests
- Re-run `bash scripts/install-harness.sh`; it must be idempotent and report no unexpected backups
- `ls -la ~/.pi/agent` — installed entries must be symlinks into this repo

## Child DOX Index

None — leaf directory.
