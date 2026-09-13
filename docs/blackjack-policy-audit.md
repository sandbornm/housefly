# Housefly Blackjack Policy Audit

2026-09-12. Bounded, independent audit of the implementation published at
`dbf3d40`. Production source was not edited. The generated histories record SHA-256
hashes of all five audited source files and `index.html`; those hashes still
matched at completion.

## Findings

No P0/P1 rule, settlement, information-leak, or exact single-hand EV defect was
found in this audit. There is one reproducible P2 policy-quality finding:

**P2: a close Split/Hit decision can be reversed by the fixed 16,000-sample
estimate, even at zero choice noise.** In seed 17, decision 30, round 19,
Housefly hits `3,3` against dealer `9`. Exact finite-composition evaluation with
optimal continuation across both split hands prefers Split by **0.0122095424
units per original stake**. This is an approximation failure, not an illegal
move or a misapplication of dealer-blackjack rules.

Relevant locations:

- `src/activities/blackjackRollout.ts:58`: fixed default of 16,000 samples.
- `src/activities/blackjackOdds.ts:143`: sampled Split is compared with exact H/S/D.
- `src/activities/blackjackOdds.ts:155`: point estimates determine the recommendation;
  reported sampling uncertainty does not affect selection.
- `src/main.ts:184`: legal-action filtering and zero-noise selection carry that
  recommendation into real play.

Exact reproduction observation, rank-count order `A,2,3,4,5,6,7,8,9,10`:

```text
player = [3,3], dealer = 9
shoe = [2,3,1,0,2,4,2,2,2,9]
one unsplit playing hand, bet 1, activeHand 0
allowDouble = true, allowSplit = true, fromSplit = false
```

| Quantity | EV |
| --- | ---: |
| Exact Stand | -0.546044840827450 |
| Exact Hit | -0.352832969372634 |
| Exact Double | -1.073605846649325 |
| Exact optimal Split, two-hand cap | -0.340623426961411 |
| Exact Split under the frozen continuation policy | -0.341256544643781 |
| Production Split, 16,000 samples | -0.365937500000000 |
| Production Split, 1,000,000 samples | -0.343698000000000 |

The default Split sampling interval is +/-0.0266040512. The frozen policy's
loss relative to optimal continuation is 0.0006331177; the default sample is
another 0.0246809554 below that policy's actual EV. Both exact optimal and exact
frozen-policy Split exceed Hit. One million samples also select Split. Thus
sampling is sufficient to explain this particular wrong ordering. A 95% interval
is not a guarantee, and this observation falls inside the reported interval.

The generic chart also says Hit here. Chart agreement alone would have missed
this finding. The TODO regression asserts the correct Split, rather than turning
the observed wrong Hit into a passing golden. A future change could allocate
additional samples near overlapping action estimates or use bounded exact
evaluation when feasible; no implementation change is included here.

## Rules and Information

| Rule | Implementation evidence |
| --- | --- |
| One physical deck by default | `blackjack.ts:56`, `main.ts:35` |
| Persisting finite shoe, shuffle between rounds | `blackjack.ts:100`, `blackjack.ts:107` |
| European no-hole-card, no peek | `blackjack.ts:111`, `blackjack.ts:127` |
| Dealer stands on soft 17 | `blackjack.ts:127` compares total to 17 |
| Natural pays 3:2; natural versus natural pushes | `blackjack.ts:142` |
| Double any initial two cards, including after split | `blackjack.ts:89`, `blackjack.ts:163` |
| One split, maximum two hands | `blackjack.ts:90`, `blackjack.ts:158` |
| Split aces get exactly one card each | `blackjack.ts:160`, `blackjack.ts:179` |
| Split 21 is ordinary 21 | `blackjack.ts:146` uses `fromSplit` |
| Dealer blackjack loses all split/double stakes | `blackjack.ts:132`, `blackjack.ts:146` |
| No surrender or insurance actions | `blackjack.ts:3`, `blackjack.ts:84` |

`main.ts:280` sends rank counts, visible player/dealer ranks, and the public
state of both hands. The worker never receives shoe order. In this ENHC game
there is no hidden reserved dealer card; initial deck contents minus all exposed
cards determine those remaining counts. The second split hand initially has one
visible card, with its next card drawn only when it becomes active. The audit
records physical draws for subsequent verification but never feeds them to an EV
calculation. Reversing the physical shoe without changing counts leaves EVs
unchanged in the regression test.

## Primary-Source Comparison

The [Wizard of Odds strategy calculator](https://wizardofodds.com/games/blackjack/strategy/calculator/)
was set to one deck, S17, DAS, no surrender, and European no-peek. The audit
checks all 360 transcribed chart cells against the downloaded `S17_0` array,
using its European ten/ace columns and resolving the DAS/surrender fallbacks.
The calculator has **no maximum-split-hands selector**. It is a matched basic
chart for its exposed settings, not proof of exact two-hand-cap splitting EV.
The independent round evaluator supplies that missing check where computation
fits the audit bound.

The separate [European strategy page](https://wizardofodds.com/games/blackjack/strategy/european/)
specifies six decks and doubles restricted to hard 9-11. It is not Housefly's
chart. A common American peek chart is also inappropriate against a ten or ace:
ENHC puts extra split and double wagers at risk of dealer blackjack.

[Appendix 9's original one-deck S17 EV tables](https://wizardofodds.com/games/blackjack/appendix/9/1ds17r4/)
provide independent numeric goldens. Their ordinary tables condition on no dealer
blackjack and permit resplitting to four hands. Tests therefore use unsplit H/S/D
rows versus 2-9 directly. For fixed Stand and Double versus ten, tests explicitly
uncondition using dealer-BJ probability 4/49 and losses of one and two units.
That shortcut is not claimed for adaptive Hit or Split policies.

Composition matters even just after a shuffle. For `6,2` versus `5`, the published
Hit EV is 0.130630 and Double EV is 0.130583, to six decimals. The correct exact
golden is **Hit**, despite the total-dependent hard-8 chart cell saying Double.
The new reference test uses that correct golden. No existing test golden needed
editing. The author's [single-deck composition exceptions](https://wizardofodds.com/games/blackjack/composition-dependent-strategy-one-deck-stand-soft-17/)
also explain why total-only charts cannot settle every finite-composition choice.

## Recorded Play

These are actual successive `createGame`/`dealRound`/`step` games, not independent
fabricated hands. Game and policy PRNG streams match `main.ts:21`. Every decision
goes through the actual worker handler with the runtime payload and then
`chooseFromActions`; both seeds use the default zero choice noise. Natural hands
settle without a decision. Runs finish the current round, so target 30 yields 31
decisions for seed 17.

| Seed | Decisions | Rounds | Exact / mixed / sampled | Chart matches | Session reward |
| --- | ---: | ---: | --- | ---: | ---: |
| 5 | 60 | 45 | 46 / 11 / 3 | 58 | -10.5 |
| 17 | 31 | 19 | 23 / 5 / 3 | 28 | +4 |
| Total | 91 | 64 | 69 / 16 / 6 | 86 | -6.5 |

The 85 unsplit observations' H/S/D values matched the independent evaluator with
maximum observed absolute difference **0** in double-precision output. All six
post-split decisions agreed with independent optimal whole-round selection.
Exact Split evaluation completed for 13 of 16 pair observations: 12 selected
the optimum and one produced the P2 finding above. Three split alternatives
exceeded the independent budget: seed 5 #12, seed 17 #1 and #14. Overall, 87 of
88 decisions with all legal actions independently evaluated selected the
optimum; three remain uncertified. These are coverage counts, not a statistical
estimate of long-run error rate or house edge.

All five chart deviations have a higher independently verified EV:

| Seed / decision / round | Player vs dealer | Chart | Selected | Selected EV | Chart EV |
| --- | --- | --- | --- | ---: | ---: |
| 5 / 34 / 25 | 10+3+2 vs 7 | Hit | Stand | -0.290225815 | -0.542473159 |
| 5 / 41 / 32 | 4+5 vs 6 | Double | Hit | +0.086010004 | +0.010229721 |
| 17 / 8 / 5 | 5+6 vs 10 | Hit | Double | +0.219166493 | +0.112129082 |
| 17 / 16 / 10 | 7+6 vs 2 | Stand | Hit | -0.322759581 | -0.347216380 |
| 17 / 31 / 19 | 3+3+10 vs 9 | Hit | Stand | -0.539588527 | -0.659850222 |

For example, seed 5 #34 has no twos, fours, or fives left: counts
`[3,0,2,0,0,4,3,4,3,10]`. Standing on 15 is justified by that composition.
Seed 17 #8 has counts `[1,2,1,2,2,3,1,1,1,9]`: only one ace remains to complete
dealer blackjack, making Double correct despite the fresh-shoe ENHC chart.

The browser check independently ran six real autoplay decisions at
`http://127.0.0.1:5173/?seed=5`, compared actual Worker payloads, raw returned EVs,
and displayed selections with the history, and found no page errors. It used
the existing server and changed only the local page's speed/pause controls.
It did not override game outcomes or RNG. Browser JSON and a screenshot are
included in the ignored output directory.

## Exactness and Approximation

`blackjackOdds.ts:56` and `blackjackOdds.ts:92` enumerate without replacement.
Single-hand Hit continues with optimal Hit/Stand; Double becomes unavailable
after that hit, so this restriction matches the game. Initial Double integrates
one player draw, dealer play, and both staked units. These branches are exact
for the supplied composition, subject to floating-point arithmetic.

Split changes that claim. `blackjackRollout.ts:11` computes continuation choices
using fixed initial rank probabilities. `blackjackRollout.ts:66` then simulates
physical draws without replacement and one shared dealer, including previously
completed hands' stakes. The continuation controller does not update its
probabilities as cards are removed and optimizes the current hand rather than
all hands' combined future reward. Runtime replans after each actual move, so
the continuation evaluated inside a rollout also differs from future runtime
selection. This is a documented approximation, not an exact all-action policy.

Independent evaluation of that frozen policy separates policy loss from sample
error. For seed 17 #19 (`8,8` vs `10`), optimal Split EV is -0.572266209; exact
frozen-policy EV is -0.578638320. One million production samples give
-0.578711 +/-0.003119742, consistent with the latter. The 0.006372111 policy
loss persists as sampling grows. Hit remains best there. The largest measured
frozen-policy loss among the 13 completed split checks is 0.008544511 units
(seed 5 #45); it also does not change that observation's chosen action.

`main.ts:300` explicitly labels sampling intervals and frozen continuation;
`main.ts:304` distinguishes exact, mixed, and sampled results. Those intervals
cover sampling uncertainty, not continuation-policy bias. Reproducible sampling
does not make the estimate exact. Nonzero choice noise adds up to +/-0.11 times
temperature per action (`blackjack.ts:185`), intentionally permitting further
departures. All history in this report uses noise zero.

## Reproduction and Validation

From the repository root, with existing dependencies and Node 24:

```sh
node scripts/audit_blackjack.ts 5 60
node scripts/audit_blackjack.ts 17 30
node scripts/audit_blackjack.ts --source-check
node scripts/audit_blackjack.ts --split-checks
node scripts/audit_blackjack.ts --browser-check
node --test tests/blackjack.test.ts tests/blackjack-actions.test.ts tests/blackjack-reference.test.ts
```

`--source-check` downloads the original calculator only if its snapshot is
missing. It parses the published array with the installed TypeScript parser;
it does not execute downloaded code. `--browser-check` requires the existing
local server on 5173 and Playwright Chromium. No new dependencies are required.

Results: **24 tests pass, 1 explicit TODO** for the demonstrated missed Split;
test runner exits 0. The TODO assertion currently fails `Hit !== Split`, as
intended. The other seven new tests pass, alongside all 17 existing blackjack
tests. No implementation, root configuration, dependency, account, gallery, or
submission change was made. A complete unrelated build/UI suite was not rerun.

Raw artifacts are under `test-results/blackjack-audit/`: both seeds' JSON/JSONL
histories, source HTML and transcription check, independent split checks, and
browser JSON/PNG. Histories contain initial physical shoe, every public
observation, legal actions, exact/sampled values, chosen actions, actual draws,
settled rounds, rewards, and source hashes. Only timing fields vary on replay.
Shared Playwright runs cleared that directory during the audit; artifacts were
regenerated, and the commands above restore them after future test cleanup.

The independent evaluator recomputes hand totals and settlement without calling
production arithmetic or settlement helpers. It uses explicit hand state and
string composition keys, includes the two-hand cap and dealer BJ across stakes,
and solves the joint finite-shoe decision problem. It has a 2.5-second / 350,000
memo-state bound per observation. The audit is limited to one-deck, zero-noise
play and the specified fixtures; it is not an exhaustive state-space proof,
all-seed performance certification, or an eight-deck audit.
