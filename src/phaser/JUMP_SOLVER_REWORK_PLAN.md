# Jump Solver Rework — finding the REAL maximum distance

**Status: implemented.** All five phases shipped. This document is now the
record of what was built and why, including the two bugs the engine
validation caught and the one design assumption that turned out wrong.

Replaces the closed-form `calculateMaxGap()` / `rawJumpDistanceTiles()` that
used to live in `playerPhysics.ts` (both deleted).

| Concern                            | Lives in                             |
| ---------------------------------- | ------------------------------------ |
| Physics constants, `stepMovement`  | `playerPhysics.ts`                   |
| The frame-accurate search          | `jumpSolver.ts`                      |
| Design-facing ladders and tiers    | `movementCapabilities.ts`            |
| Validation against the real engine | `__tests__/jumpSolverEngine.test.ts` |

---

## 1. The problem

`calculateMaxGap(runwayTiles, deltaYTiles)` was continuous-kinematics
algebra. It assumed the player takes off from a standstill, runs exactly
`runwayTiles`, and jumps the instant the body reaches the tile boundary. Real
Pewter physics is a discrete frame loop (`stepMovement` → gravity → integrate
→ resolve) with a 10×14px body, coyote time, and per-frame collision
resolution. The formula was not a conservative approximation of that loop — it
was a different model, and it was wrong in one direction: **it always
under-reported.**

### What the formula never modelled

**1. Coyote time — the big one.** `COYOTE_TIME = 0.06s` ≈ 3–4 frames at 60fps.
The player can run _completely off_ the ledge, keep accelerating airborne, and
_then_ jump. That buys horizontal distance during those frames and buys
airtime, because the launch point is below platform level so the fall back to
that level is longer. The formula had no term for it.

**2. Sub-tile takeoff geometry.** The body is 10px wide, so at takeoff its
leading edge is already 10px past the ledge, and at landing only that leading
edge needs to reach the target.

**3. Frame quantisation.** Landing resolves on a frame boundary, so the true
answer depends on frame rate and on the sub-pixel phase at which the player
arrives at the ledge. A continuous formula cannot express either.

**4. Takeoff phase control.** Inserting an idle frame during the run-up shifts
frame alignment at the ledge, worth up to one frame of travel (~4.3px at
60fps).

### Split-brain

`calculateJumpGaps` (the tool Pewter called) used `calculateMaxGap`, while
`reachability.ts` and `movementPrompt.ts` used a _different_ derivation
(`rawJumpDistanceTiles` + `MOVEMENT_CAPABILITIES`). Nothing kept the two in
sync, so Pewter could be told a gap was fine by one and have `verifyComplete`
reject it via the other. Both are now deleted; there is one engine.

---

## 2. Results

Level target (deltaY = 0), gap measured ledge-edge to target-edge. "Legacy" is
the retired formula. GUARANTEED/NORMAL/EXPERT/ULTRA are worst-case across
30/60/144fps; "best case" is the best single frame rate.

| runway | legacy | GUARANTEED | NORMAL | EXPERT | ULTRA | best case | gain vs legacy |
| -----: | -----: | ---------: | -----: | -----: | ----: | --------: | -------------: |
|      0 |   4.98 |       7.64 |   8.95 |   9.39 |  9.77 |      9.87 |      **+4.79** |
|      1 |   8.99 |       9.10 |  10.41 |  10.85 | 11.16 |     11.24 |      **+2.17** |
|      2 |  10.09 |       9.88 |  11.20 |  11.63 | 11.88 |     12.05 |      **+1.80** |
|      4 |  11.05 |      10.60 |  11.91 |  12.35 | 12.66 |     12.74 |      **+1.61** |
|      7 |  11.33 |      10.57 |  11.94 |  12.38 | 12.76 |     12.89 |      **+1.42** |

The old formula was leaving **1.4–4.8 tiles** on the table — worst on the
standing jump, where it reported 4.98 tiles against a real 9.77 (+96%).

Note the GUARANTEED column sits _below_ the legacy number at runway ≥ 2. That
is correct and intentional: legacy claimed a single number with a flat 0.4-tile
fudge and no notion of how much timing precision it demanded. GUARANTEED is a
real promise — 150ms of slack at every frame rate. The old number was roughly
an EXPERT-tier jump being sold as a safe one.

### Difficulty = jump-timing latitude

Milliseconds of slack on the jump press, worst case across frame rates, at
runway=4:

| gap (tiles) | timing slack | tier       |
| ----------: | -----------: | ---------- |
|           5 |        500ms | GUARANTEED |
|           8 |        313ms | GUARANTEED |
|          10 |        194ms | GUARANTEED |
|          11 |        132ms | NORMAL     |
|          12 |         63ms | EXPERT     |
|        12.5 |         28ms | ULTRA      |

Measured in **milliseconds, not frames**, so a tier means the same thing at
30fps and 144fps — human timing precision is wall-clock, not frame-indexed.

### The shipped ladders

| tier       | runway→gap              | step-up | impossible gap | impossible wall |
| ---------- | ----------------------- | ------: | -------------: | --------------: |
| GUARANTEED | 0→7 1→9 2→9 4→10 7→10   |       5 |             13 |               7 |
| NORMAL     | 0→8 1→10 2→11 4→11 7→11 |       6 |             13 |               7 |
| EXPERT     | 0→9 1→10 2→11 4→12 7→12 |       6 |             13 |               7 |
| ULTRA      | 0→9 1→11 2→11 4→12 7→12 |       6 |             13 |               7 |

**Tile quantisation blurs the top tiers, but does not erase them.** Whole-tile
flooring costs about a tile of resolution, so EXPERT and ULTRA share a rung at
most runways (at runway=4: 12.35 vs 12.66, both floor to 12). GUARANTEED,
NORMAL and EXPERT do separate cleanly — 10 / 11 / 12 at runway=4.

> An earlier revision of this document claimed the top _three_ tiers collapsed
> into one identical ladder. That was mostly an artifact of the bisection bug
> in §3.1, which was pinning several tiers to the same wrong value. Once the
> tier bounds were computed correctly, NORMAL separated from EXPERT.

Difficulty still comes from more than gap width. A _level_ is graded by
`classifyJump` on its actual geometry — the (runway, gap, deltaY) triple. The
strongest levers are **starving the runway** (an 11-tile gap is EXPERT off 4
tiles of run-up and impossible off 0), **climbing** (step-up 5 vs 6 separates
GUARANTEED from the rest), and **chaining** near-limit jumps.

---

## 3.1 Two bugs found afterwards, while building the frontier

Both were latent in the original solver and only surfaced when
`reachableFrontier` started asking it about _rising_ targets and _deep drops_
— the cases the flat-ground ladder never exercised. The numbers in §2 are
post-fix.

**Bisection over a non-monotonic function.** `largestGapWithLatitude` found
each tier's bound by bisecting, which silently assumes narrow gaps are always
easier than wide ones. For a target _above_ the takeoff that is false: its
leading face is a wall, so gaps narrower than your reach at that height fail
outright. The landable set is a band, not a prefix, and the bisection's
"gap ≈ 0 must work" anchor bailed immediately — a 1-tile rise reported a
NORMAL gap of **0** against an ULTRA gap of 12.08. A 4-tile drop reported
4.73 against 14.42. Replaced with a linear scan, which assumes nothing about
the shape of the function.

**Physics was being stepped at the render rate.** Arcade is a fixed-step
simulation — `Phaser.Physics.Arcade.World` defaults to `fps: 60` with
`fixedStep: true` — so gravity, integration and tile collision always advance
in 1/60 slices no matter the display refresh. A 30Hz monitor runs two 1/60
steps per rendered frame; it does not integrate at 1/30. Only the
_controller_ varies with frame rate, because `PlayerController.update()` is
called once per rendered frame with the render delta.

The solver stepped both at the same dt. At "30fps" that made the body descend
~23px per step during a deep fall, exceeding `TILE_BIAS` (16px), so the solver
believed the player tunnelled straight through the target platform. The
symptom was a 4-tile drop having exactly **one** landable jump frame at 30fps
while 60 and 144 were entirely healthy. `simulate()` now runs the controller
at the render rate and accumulates fixed 1/60 physics steps, recording one
sample per physics step. Per-rate maxima now agree to within ~0.15 tiles,
which is what fixed-step physics predicts and is itself a good regression
signal.

---

## 3. What the engine validation caught

`__tests__/jumpSolverEngine.test.ts` imports Phaser's own `SeparateTile`
chain straight out of the package — those modules are plain CommonJS and,
unlike `phaser` itself, pull in no device detection, so they run in vitest
with no DOM — and drives it with a faithful Arcade `Body` stand-in.

It paid for itself immediately, catching two bugs that every self-consistency
test had passed:

**1. The landing rule was too strict.** The solver required the body to cross
the target's surface cleanly from above. Arcade actually separates a tile
overlap on the axis of _least penetration_, so it seats you on top of a corner
clip far more readily than that. The faithful rule is `sink ≤ overlap`, and it
raises the true maximum. Caught when the real engine landed a jump the solver
called impossible.

**2. `impossibleTiles` was derived from the wrong statistic.** It came from
the worst-case frame rate, but _"can I require this?"_ and _"is this flatly
impossible?"_ are questions about different machines. At runway=0 the engine
cleared a 10-tile gap that the solver had declared impossible, because 144fps
reaches 10.05 tiles while the 30fps-limited figure is 9.55. Requirable tiers
now come from the worst rate and `impossibleTiles` from the best, as separate
fields (`ultraTiles` vs `bestCaseUltraTiles`). Getting this backwards made the
reachability checker invent dead ends that a high-refresh player walks
straight past.

A third assumption also turned out wrong, though harmlessly: a ceiling **over
the runway** constrains nothing at all, because the longest jumps launch from
past the ledge and simply fly out from under it. `ceilingTiles` is therefore a
_corridor_ height spanning the runway and the gap.

---

## 4. Design notes

**Tiers.** `TIER_LATITUDE_MS` = GUARANTEED 150ms, NORMAL 66ms, EXPERT 32ms,
ULTRA >0. `HUMAN_HARD_TIER` is EXPERT: ULTRA is a 1-frame window at 60fps that
_also_ depends on a sub-pixel takeoff phase the player cannot see. It exists so
the dial has a top end and so geometry can be checked against the true physical
bound — but requiring it is a bug, not a difficulty setting. `BRUTAL` maps to
ULTRA and the prompt tells Pewter to keep those jumps on optional routes only.

**Difficulty dial.** EASY→GUARANTEED, NORMAL→NORMAL, HARD→EXPERT,
BRUTAL→ULTRA. It gates the hardest jump a level may _require_.
`checkTraversal` and `verifyComplete` validate against it and report the
level's rating: hardest required jump, plus how many near-limit jumps sit close
enough together to chain.

**What a reachability PASS now means** is weaker than it used to be, and this
is the one real cost of the rework. It used to mean "genuinely beatable by a
competent player"; it now means "beatable at the declared tier". That is only
safe because the tier is explicit — EASY levels still get the old promise, so
the guarantee survives where it matters.

**Everything is lazy.** A cold solve is ~50–100ms and the full fact-sheet
needs a dozen, so `movementCapabilities` computes on first access and memoises.
The running game must never pay that just to read a gravity constant — which is
also why the derivation lives in its own module rather than in
`playerPhysics.ts` (`jumpSolver` imports `playerPhysics`, so putting it there
would be a cycle).

**Performance.** The first version took 13.7s to build the fact-sheet. Two
fixes brought it to ~2.2s with _better_ accuracy: the jump-frame lookback was
scaled by `1/dt`, sweeping 230 frames of pointless run-up per phase at 144fps
(now capped at 0.6s of real time); and the hold-duration sweep ran for every
rising target, when cutting a jump short can only reduce both apex and airtime
— so with open sky a full hold strictly dominates and the sweep is only needed
under a ceiling. Coarsening the sub-pixel phase step was tried and reverted: at
1px, runway=1 quietly lost a whole tile off its GUARANTEED rung.

---

## 5. Tests

- `jumpSolver.test.ts` (21) — tier ordering, latitude monotonicity, the
  worst-case/best-case split, independent frame-by-frame replay of every
  claim, and a lock on the coyote technique: **the optimal jump frame must be
  strictly after the ledge frame.** If that ever regresses, the search has
  lost the technique and the numbers have silently collapsed back to the
  closed-form answer.
- `jumpSolverEngine.test.ts` (5) — every claim replayed through Phaser's real
  `SeparateTile`.
- `movementCapabilities.test.ts` (16) — ladder monotonicity in both runway and
  tier, impossibility bounds, the difficulty dial, `classifyJump` on real
  geometry.
- `reachability.test.ts` (10) — rewritten to derive every bound from the
  solver instead of hardcoding tile counts. Five of these previously asserted
  that things were impossible which the player can actually do.
- `playerPhysics.test.ts` (21) — unchanged pure-physics tests. Its old
  `MOVEMENT_CAPABILITIES` cross-check was deleted rather than ported: it
  validated the ladder against a sim that jumps exactly at the ledge, which is
  precisely the model that cannot express the coyote jump.

76 tests, all passing. `vite build` succeeds.

---

## 6. Known limitations

- **Reachability's rising-jump rule is still the old heuristic** (2 tiles of
  gap per tile of rise) rather than a solver call per edge. The solver is used
  for the ladder and for `classifyJump`; wiring it into every graph edge would
  mean a solve per edge, which is too slow for the interactive checker.
- **Arc clearance is unmodelled.** Jumps check takeoff-column headroom, not
  the full flight path, so a ceiling mid-gap can still surprise the checker.
  The tool's geometry-aware mode does read corridor ceilings; the graph
  does not.
- **`stopDistanceTiles` and `maxJumpApexTiles` remain closed-form.** They are
  not gap problems and were out of scope.
- **The step-up probe uses "can still land ≥1 tile out"** as its climb
  criterion, which is a proxy for a true adjacent-wall climb.
- **`tsc` reports pre-existing errors** in `src/enemySystem` and missing
  vitest types; none are in the files this touched.
