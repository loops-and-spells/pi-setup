# pi-bench — Harness Techniques Study (2026-07-07)

Do harness techniques (best-of-N, verify-loop, sampler choice, context shape)
measurably raise a model's effective capability? Tested with **gated tasks** —
hidden executable tests score every answer objectively (`passed/total`), no
judge. Tasks: `gate-bugfix` (5 planted bugs in a Ledger module, 6 checks),
`gate-impl` (IntervalSet from spec, 9 checks), `gate-repo` (fix
`orders.checkout` against two other modules' contracts, 8 checks). Each
technique config runs on the *same* endpoint as its baseline, isolating the
technique from the model. One sample per cell. Raw outputs:
`results/harness-techniques-1` (DeepSeek), `results/qwen3-4b-techniques-1`
(Qwen).

## DeepSeek-V4-Flash 284B (vLLM + DSpark, ~140 t/s)

| Config | bugfix | impl | repo | Σ/23 | Notes |
|---|---|---|---|---|---|
| vllm-dspark (baseline, task temp) | 6/6 | 9/9 | 8/8 | **23** | saturates the suite, 3–11s/task |
| vllm-greedy (temp 0) | 5/6 | 9/9 | 8/8 | 22 | missed the stale-cache bug |
| vllm-bo3 (best-of-3) | 6/6 | 9/9 | 8/8 | **23** | recovered greedy's drop |
| vllm-verify (≤3 repair rounds) | 6/6 | 9/9 | 8/8 | **23** | draft already passed — loop exits free |
| vllm-ctx-none (target file only) | — | — | 7/8 | | hallucinated `release(sku, qty)` |
| vllm-ctx-map (+ symbol map) | — | — | 8/8 | | docstring contracts recover it |
| vllm-ctx-full (+ full files) | — | — | 8/8 | | no better than the map |

## Qwen3-4B (llama.cpp, -c 65536) — same tasks, same techniques

| Config | bugfix | impl | repo | Σ/23 | Notes |
|---|---|---|---|---|---|
| vllm-single (baseline, task temp) | 0/6 | 0/9 | 0/8 | **0** | every attempt: thinking spiral, 8192 tok, no usable code |
| vllm-greedy (temp 0) | 5/6 | 0/9 | 0/8 | 5 | temp 0 avoids the bugfix spiral |
| vllm-bo3 (best-of-3) | 5/6 | 0/9 | **8/8** | **13** | repo: perfect — matches the 284B baseline |
| vllm-verify (≤3 repair rounds) | **6/6** | 0/9 | 7/8 | **13** | bugfix: perfect after ONE round of test feedback |
| vllm-ctx-none/map/full | — | — | 0/8 | | uninterpretable: single-shot spirals dominate |

(An earlier 16k-ctx attempt recorded baseline 4/6 on bugfix where this run
spiraled to 0/6 — same config, same task: small-thinking-model single shots
are coin flips. The techniques are exactly the variance collapse.)

## Council ladder A/B (council-v3, 2026-07-07)

The production changes this study motivated, measured before adoption
(`results/council-v3-1`). `council-v3` = ornith-council + the proxy's new
resample ladder: when the checked/revised answer still fails code-computable
checks (`draftFormatViolations` — empty/truncated/codeless spiral signatures;
never hidden tests), resample fresh at raised temperature, keep the least
violating.

| Config | bugfix | impl | repo | Σ/23 | Wall |
|---|---|---|---|---|---|
| ornith-council (production) | 6/6 | 9/9 | 8/8 | **23** | 33s / 104s / 32s |
| council-v3 (+ ladder) | 6/6 | 9/9 | 8/8 | **23** | 27s / 145s / 31s |

The production council *saturates the gated suite* (independent evidence that
`pi-engine use council` is the right default), so the ladder's rescue path
never fired — zero `resample:` stages, zero overhead on clean drafts (deltas
are single-sample variance; v3's slower impl cell was a checker-triggered
revision, present in both configs). The rescue behavior itself is the Qwen3-4B
result above (0/8 → 8/8). Ladder shipped in the proxy with
`COUNCIL_RESAMPLES=2` default; the verify-gate pi extension carries the
executable-feedback loop (the 0/6 → 6/6 lever) into real editing sessions.

## Durable findings

1. **Verification loops and best-of-N buy real IQ, and the smaller the model
   the bigger the buy.** Qwen3-4B: 0/23 → 13/23 under either technique, for
   ~2–3× tokens on a model where tokens are nearly free. On gate-repo,
   4B + best-of-3 *equals the 284B model*. On the big model the same
   techniques cost almost nothing and act as insurance (bo3 recovered
   greedy's dropped check).
2. **The two techniques rescue different failures** — verify-loop won bugfix
   (6/6; one round of failing-test feedback), best-of-3 won repo (8/8;
   independent resampling escapes the spiral). A production harness should
   compose them: sample N, gate, feed failures back into the best candidate.
3. **Sampler choice is a per-model decision, not a global default.** Temp 0
   *hurt* the 284B (5/6 vs 6/6) and *helped* the 4B (5/6 vs 0/6, and its only
   deterministic escape from thinking spirals on that task).
4. **Symbol maps carry the signal.** The one baseline miss on gate-repo came
   from guessing another module's function signature (`ctx-none`); a
   signatures+docstrings map fully recovered full-file quality. Contracts
   should live in docstrings — that's what the map transmits.
5. **Some walls are model walls.** gate-impl resisted every technique on the
   4B (0/9 across 8 attempts): when the model can't fit spec-grade reasoning
   in its budget, no amount of resampling or feedback rescues it. Techniques
   raise the floor and stabilize; they don't add a tier.
6. **Ops:** parallel best-of-N on llama-server needs ctx ≥ N×(prompt+maxTokens)
   — at 16k all three candidates 500'd with "Context size has been exceeded".

---

# pi-bench — Final Report: Model & Mixture Matrix (2026-07-06)

Fourteen configurations benchmarked on four tasks against hidden rubrics.
Judged blind by Claude (Fable 5); objective tasks pre-scored by delegated
agents against answer keys; every claimed-executable deliverable actually run.
One sample per cell — gaps under ~10 points are noise.

**Tasks:** `api-critique` (10 seeded design/security flaws), `bug-hunt` (8
seeded concurrency/logic bugs), `glyph-esolang` (invent + implement an
esoteric language, examples must execute), `race-noir` (constrained creative
writing encoding a lost-update race). Rubrics and answer keys live in
`tasks/*.json`; raw outputs and per-run verdicts in `results/`.

## The complete matrix

| # | Config | What it is | api | bug | glyph | noir | **/400** | Wall/task |
|---|--------|------------|-----|-----|-------|------|----------|-----------|
| 1 | **ornith-tuned** | Ornith-397B IQ3, ctx 49152, thinking capped 8k | 90 | 87 | 34¹ | **94** | **305** | 34–107s |
| 2 | **council-v2** | MiniMax chair + gemma/qwen advisors + qwen check→revise | **98** | 85 | 31 | 90 | **304** | 49–370s |
| 3 | council-vllm | MiniMax+gemma briefs → vLLM chair + self-check | 88 | 96 | 32 | 85 | 301 | 73–343s² |
| 4 | vllm-dspark | DeepSeek-V4-Flash 284B, vLLM + DSpark spec-dec | 93 | 87 | **37** | 83 | 300 | **3–13s** |
| 5 | devstral-solo | Devstral 2 123B dense Q4, one GPU | 87 | 88 | 34 | 88 | 297 | 29–106s |
| 6 | qcn-council | QCN chair + devstral/gemma advisors + gemma check | 88 | **99** | 22 | 87 | 296 | 109–268s |
| 7 | council (v1) | MiniMax chair + gemma/qwen advisors, no check | 90 | 95 | 32 | 77 | 294 | 35–241s |
| 8 | qcn-solo | Qwen3-Coder-Next 80B-A3B UD-Q4, one GPU | 89 | 89 | 24 | 84 | 286 | **4–179s** |
| 9 | ornith-solo | Ornith-397B IQ3, unbounded thinking | 90 | **98** | 0³ | 89 | 277 | 39–110s |
| 10 | gemma-solo | gemma-4-31B QAT Q4 | 87 | 78 | 18 | **91** | 274 | 22–134s |
| 11 | chairman-solo | MiniMax-M2.7 Q4 alone | 88 | 95 | 0³ | 87 | 270 | 45–141s |
| 12 | devstral-council | Devstral chair (split) + gemma/qwen + qwen check | 88 | 96 | 0⁴ | 85 | 269 | 80s–DNF |
| 13 | llama-v4 | DeepSeek-V4-Flash MXFP4, llama.cpp + NCMOE | 89 | 89 | 0⁴ | 84 | 262 | 27–105s |
| 14 | qwen36-solo | Qwen3.6-35B-A3B Q4 | 90 | 12³ | 0³ | 87 | 189 | 17–31s |

¹ flaky: 1 of 2 attempts completed under the cap; the other timed out.
² plus a ~10-min engine swap between advisor and synthesis phases.
³ empty answer — thinking consumed the entire token budget.
⁴ did not finish within 30 minutes.

Excluding glyph (the task nobody passes — best score 37/100, zero working
interpreters in 14 attempts): ornith-solo 277/300 leads, then qcn-council 274,
council-v2 273, ornith-tuned 271, chairman-solo 270.

## Council lift (council score − best member's solo score)

| Council | Score | Best member solo | Lift |
|---|---|---|---|
| council-v2 | 304 | gemma 274 | **+30** |
| council v1 | 294 | gemma 274 | +20 |
| qcn-council | 296 | devstral 297 | −1 (+10 over its chairman) |
| council-vllm | 301 | vllm 300 | +1 |
| devstral-council | 269 | devstral 297 | **−28** (glyph DNF; ex-glyph +6) |

**The council-lift law:** orchestration pays when the chairman deliberates
poorly alone (MiniMax: advisors collapse its thinking ~70k→5k chars, +20/+30).
It pays little for already-efficient chairmen overall (vLLM +1) while still
transforming single task classes (qcn-council +10 over its chairman on bugs).
It goes negative when the advisors are weaker and slower than the chairman
(devstral-council). The thinking-budget flag achieves most of the advisors'
focusing effect for free (ornith 277→305) — orchestration and decoding
controls are partially interchangeable.

## Per-task champions

- **api-critique 98 — council-v2**: only perfect-recall answer with zero
  invented flaws, produced by checker-triggered revision.
- **bug-hunt 99 — qcn-council**: all 8 bugs, minimal fixes, avoided the
  reserve()/total() deadlock trap that snared five other configs.
- **glyph 37 — vllm-dspark**: nobody shipped a working language; 14/14 failed
  execution (crashes, hangs, empties, degenerate token floods). Kept as the
  suite's honesty probe: every model claims exact outputs that don't reproduce.
- **race-noir 94 — ornith-tuned**: perfect constraints, accurate lost-update
  interleaving, best prose of the night. Runner-up gemma-solo (91) — a 31B
  beating every council at creative writing.

## Durable findings

1. **Thinking budgets are a per-task lever, not a default.** Capping Ornith
   fixed empty-answer spirals (+34 glyph, +5 noir) and cost analytical depth
   (−11 bug-hunt). Uncapped for deep review; capped for constrained deliverables.
2. **Independent checking works; self-checking doesn't.** qwen-as-checker
   caught real violations and produced the 98; vLLM checking its own drafts
   said PASS 4/4 including on a draft missing a required section.
3. **LLM checkers can't count** (word-count violations passed every checker)
   and overflow on huge drafts. Constraint checks that are computable should
   be code, not model calls.
4. **Small models have spiky value**: gemma-4-31B is a top-2 creative writer
   and a competent checker; qwen3.6 is a fine advisor but catastrophic solo
   (thinking eats its budget → empty answers).
5. **Never let a fix introduce a deadlock**: 5 of 12 scoring configs proposed
   reserve()-holds-lock-calls-total()-takes-lock composites. qcn-council and
   qcn-solo inlined correctly.
6. **Engine notes**: llama-v4's NCMOE CPU-expert offload collapses ~8× on
   punctuation-dense generation (30-min DNFs). The `hf` CLI stalled repeatedly
   on 50GB+ unsloth files; `curl -C -` on resolve URLs was flawless.

## Deployment (as configured now)

| Role | Config | Why |
|---|---|---|
| pi daily driver | **vllm-dspark** | 300 quality at 3–13s — the speed×quality product is untouched |
| Max-quality single model | **Ornith-397B** (tuned or uncapped per task) | 305 tied-best overall / 98 best-solo bug hunter, ~92–95 t/s, MIT |
| Deep review pipeline | **qcn-council** | benchmark-best bug hunting (99), fully co-resident, ~2 min/answer |
| Max-quality pipeline | **council-v2** | 304, best critique (98), real-time viable |
| Creative drafting | **gemma-solo** | 91 noir at 31B; nearly free alongside anything |
| Never | qwen36-solo, devstral-council | empty answers / negative lift |

Council members are pi providers (`council-*`, ports 9100–9106) served via
`bun run bench -- council up`. Models live in `~/Machine/models/{gguf,hf}/<model>/`.

**ornith-council is also a first-class engine** (2026-07-06): `pi-engine use
council` starts `ornith-council.service` — Ornith (:9103) + the scout (:9107)
behind an OpenAI-compatible proxy on :9110 — and points pi's default at model
`ornith-council`. The proxy runs scout-brief → Ornith → scout-check → revise
on user turns, passes tool-call turns straight through (pi's agentic loop
keeps native tool calling), and also exposes `ornith-397b` as a passthrough
model. `pi-engine use vllm` swaps back to the fast daily driver.

**pi-council extension** (2026-07-06, `apps/pi-council`, symlinked into
`~/.pi/agent/extensions/`): runtime role picking inside pi itself. `/council`
assigns any registered OpenAI-compatible model as advisor (scout | skeptic |
architect lens) or checker; the chairman is whatever model pi is on. Briefs
inject via `before_agent_start`, the checker audits on `agent_end` and
violations trigger one budgeted revision turn. `council-scout.service` serves
the 2.3GB Qwen3-4B on :9107 alongside any engine (auto-started by the
extension), enabling vllm-chairman + scout-checker at daily-driver speed.
Config persists in `~/.pi/agent/council.json`; off by default.

## Follow-up round (2026-07-06): the three open items, answered

Three additional configs (17 total benched):

| Config | api | bug | glyph | noir | /400 | ex-glyph /300 |
|---|-----|-----|-------|------|------|---------------|
| **ornith-council** (Ornith + Qwen3-4B scout as advisor+checker) | **100** | 91 | 0¹ | **93** | 284 | **284 — best ever** |
| chairman-tuned (MiniMax + reasoning budget) | 93 | 87 | 0¹ | 91 | 271 | 271 |
| council-v2-rb (council-v2 with capped chairman) | 93 | 87 | 3² | 87 | 270 | 267 |

¹ timed out — glyph remains a coin-flip for capped thinkers and a wall for MiniMax.
² emitted 40k tokens of design monologue, no deliverable.

**1. Ornith + tiny advisor: the hypothesis held.** A 2.3GB Qwen3-4B scout
(requirement checklist + hardest-parts brief, doubling as checker) took capped
Ornith from 271 to **284 ex-glyph — the strongest three-task result of the
entire benchmark**, including the benchmark's first perfect cell
(api-critique 100/100) and its second-best noir (93). The scout restored about
half the analytical depth the thinking cap costs (bug 87→91 vs uncapped 98)
while keeping the reliability and adding ~25GB/GPU of headroom worth of
council for 2.3GB. Cost per answer: one 4B brief + one 4B check ≈ 3s overhead.

**2. Reasoning budget on MiniMax: negative result.** chairman-tuned gained +1
overall (270→271, redistributed not lifted), and capping the chairman inside
council-v2 was actively harmful (304→270): the advisors already fix MiniMax's
deliberation, so the cap only cuts depth — and under it, MiniMax leaks
planning monologue into answers. The budget lever is Ornith-specific medicine.
It also exposed a pipeline bug (a degenerate one-word "revision" clobbering a
good draft) — now guarded: revisions shorter than max(200 chars, draft/4) are
discarded and drafts are persisted in stage records.

**3. Deterministic pre-checks: shipped and validated.** `hardConstraints` in
task JSON (required strings, word ranges) are computed in code before the LLM
checker; deterministic violations force a revision even on a rubber-stamp
PASS. In the follow-up runs every noir cell landed in the 350–450 window with
the required sections — the era of word-count violations sailing past LLM
checkers is over.

## The glyph assault (2026-07-06): execution feedback, and why glyph stays unbeaten

To try to get glyph passing, the checker stage gained **real execution
feedback** (`execExamples` hardConstraint): the pipeline extracts the
interpreter and the three example programs from the draft, runs them with
timeouts, and feeds exact failures ("Example 1: never terminates", "output
mismatch: expected X got Y") back for up to two repair rounds, plus a bounded
chairman timeout with retry and a ship-the-draft-on-failed-repair guarantee.

The machinery works — and the answer is still no:

- Round 1: all 3 programs hang → Ornith produced a serious rewrite.
- Round 2: rewrote two programs again → **all 3 still hang**. It patches
  programs, never the broken loop semantics in its own language design.
- Council-mode drafts stalled 4/4 (the scout brief reliably triggers the
  content-induced generation collapse), and revision contexts (punctuation-
  dense drafts + failure excerpts) collapse throughput ~5×.

Conclusion: glyph — design a language, implement it, and ship examples that
actually run — exceeds the self-repair capability of every local model on
this box (17 configs, 3 pipeline generations, real execution feedback). The
exec-feedback loop stays: it drives genuine rewrites and will catch
shallower bugs in ordinary code tasks, and the harness can now auto-verify
any future model against glyph in one command.

## Final standings

- **Overall (with glyph):** ornith-tuned 305 · council-v2 304 · council-vllm 301 · vllm-dspark 300
- **Real-work three tasks (ex-glyph):** **ornith-council 284** · ornith-solo 277 · qcn-council 274 · council-v2 273
- **Production:** vllm-dspark drives pi; **ornith-council** is the new
  consultation/review champion (one big model + one tiny scout — simpler AND
  stronger than the three-model councils); qcn-council remains the bug-hunt
  specialist (99); gemma-solo for creative drafts.
