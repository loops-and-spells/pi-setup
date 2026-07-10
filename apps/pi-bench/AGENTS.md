# apps/pi-bench

## Purpose

Benchmark harness with two studies: engines/councils vs each other (blind-judged), and harness *techniques* A/B'd on one endpoint (objectively gated). Its job is to make every harness decision a measured claim.

## Ownership

- `src/configs.ts` — config registry; `technique` configs (bo3, verify, greedy, ctx-*) all run on the vLLM endpoint
- `src/gate.ts` — objective scoring: extracts the answer's code block, runs hidden tests, counts CHECK lines
- `src/runner.ts` — sessions + per-config runners; technique runners live in their own section
- `src/report.ts` — metrics.md (identified, incl. gate-score matrix), judge-pack.md (blind, non-gated tasks only)
- `tasks/*.json` — task definitions; `results/` — immutable run outputs
- `test/gate.test.ts` — offline evidence that gates score correctly (reference solutions pass 100%, planted originals fail exactly the planted checks)

## Local Contracts

- Gated tasks (`gate` field) are scored by hidden tests in code; `judgeNotes`/judge pack never apply to them. `gate.totalChecks` must equal the number of `check()` calls in `gate.tests`
- Hidden test source is NEVER sent to any model. The verify-loop feeds back only failing check names and error text (what a real test run prints)
- Every config gets gate scores automatically via `runTasksFor` — new configs need no gate wiring
- `repoContext` tasks: JSON `prompt` excludes the files; the loader embeds all files for non-ctx configs (`rawPrompt` keeps the bare prompt for ctx variants)
- `ctx-map` renders through `@pi-setup/core`'s `buildSymbolMap` (tree-sitter) — the same implementation the repo-map pi extension injects; measure against that shared code, never a local variant
- `TECHNIQUE_PORT`/`TECHNIQUE_MODEL` env point technique configs at any serving endpoint (small-model lift studies); the caller owns that server. On llama-server the ctx must hold bo3's THREE CONCURRENT generations — serve with at least `-c 3*(prompt+maxTokens)` (65536 works for the gated set) or all candidates 500 with "Context size has been exceeded"
- `council-v3` mirrors the production proxy's resample ladder (`packages/core/src/serve/council.ts`) — keep the two implementations in sync, and never let proxy-layer configs (council-*) see gate/hidden-test feedback; only `draftFormatViolations` + hard constraints (what the real proxy can compute)
- Taste A/B: a task's `tasteRules` are NEVER sent to `taste-off` — that asymmetry is the measurement. `src/taste.ts`'s `renderTasteBlock` must stay byte-identical to `harness/extensions/taste.ts` (test-enforced), and `GENERIC_TASTE_RULES` (the regression payload for tasks without rules) must stay neutral to every existing gate's hidden checks — a rule that hints at a planted bug turns the regression measurement into a leak
- One sample per cell — treat small deltas as noise; rerun before believing a surprise
- Results directories are evidence: never edit or delete them

## Verification

- `bun test` (test/gate.test.ts) — must pass before any gated-task or gate-machinery change lands
- `bun run typecheck`

## Child DOX Index

None — leaf directory.
