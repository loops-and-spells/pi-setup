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
- `extensions/subagent/` — subagent extension (vendored from pi's bundled examples)
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
