# Jump Solver Rework — finding the REAL maximum distance

Status: plan, not yet implemented.
Supersedes the closed-form `calculateMaxGap()` in `playerPhysics.ts` and the
`gapForRunway` ladder that `reachability.ts` and `movementPrompt.ts` read.

---

## 1. The problem

`calculateMaxGap(runwayTiles, deltaYTiles)` is continuous-kinematics algebra.
It assumes the player takes off from a standstill, runs exactly `runwayTiles`,
and jumps at the instant the body reaches the tile boundary. Real Pewter
physics is a discrete frame loop (`stepMovement` → gravity → integrate →
resolve) with a 10×14px body, coyote time, and per-frame collision resolution.
The formula is not a conservative approximation of that loop — it is a
different model, and it is wrong in one direction: **it always under-reports.**

### Four things the formula never models

**1. Coyote time (the big one).** `COYOTE_TIME = 0.06s` ≈ 3–4 frames at 60fps.
The player can run _completely off_ the ledge, keep accelerating airborne, and
_then_ jump. That buys horizontal distance during those frames and buys
airtime, because the launch point is now below platform level so the fall back
to that level is longer. The formula has no term for this at all.

**2. Sub-tile takeoff geometry.** The body is 10px wide, so at takeoff the
body's _leading edge_ is already 10px past the ledge, and at landing you only
need that leading edge to touch the target tile's leading edge. Measured
edge-to-edge, the crossable gap is roughly `flightDistance + bodyWidth`
(+0.625 tiles). The formula instead _subtracts_ a flat 0.4-tile margin. Net
geometric error ≈ 1.0 tile before coyote time is even counted.

**3. Frame quantization.** Landing resolves on a frame boundary, so the true
answer depends on frame rate and on the sub-pixel phase at which the player
arrives at the ledge. A continuous formula cannot express either.

**4. Takeoff phase control.** The player can insert an idle frame during the
run-up to shift their frame alignment at the ledge. This is a real technique
and it moves the answer by up to one frame of travel (~4.3px at 60fps).

### Split-brain: two disagreeing sources of truth

`calculateJumpGaps` (the tool Pewter calls) uses `calculateMaxGap`.
`reachability.ts` and `movementPrompt.ts` use a _different_ function,
`rawJumpDistanceTiles` + `MOVEMENT_CAPABILITIES.gapForRunway`. Today they
happen to agree numerically, but nothing enforces that — they are separate
derivations of the same physics. Pewter can be told a gap is fine by one and
have `verifyComplete` reject it via the other.

---

## 2. Measured evidence

Frame-accurate sim built on the real `stepMovement`, sweeping sub-pixel takeoff
phase × jump frame × hold duration. Level target (deltaY = 0), gap measured
ledge-edge to target-edge.

| runway (tiles) | `calculateMaxGap` | real max @30fps | @60fps | @144fps | **worst rate** | under-report |
| -------------: | ----------------: | --------------: | -----: | ------: | -------------: | -----------: |
|              0 |              4.98 |            7.29 |   7.16 |    6.95 |       **6.95** |    **+1.97** |
|              1 |              8.99 |           10.56 |  10.74 |   10.84 |      **10.56** |    **+1.57** |
|              2 |             10.09 |           11.42 |  11.87 |   11.88 |      **11.42** |    **+1.34** |
|              4 |             11.05 |           12.55 |  12.85 |   12.72 |      **12.55** |    **+1.50** |
|              7 |             11.33 |           12.89 |  13.15 |   12.72 |      **12.72** |    **+1.39** |
|             20 |             11.33 |           12.89 |  13.15 |   12.72 |      **12.72** |    **+1.39** |

The tool is leaving **1.3–2.0 tiles** of real reach on the table, worst at a
standing jump (+40%).

The optimal input for runway=4 @60fps is `takeoffPhase=1.50px, jumpFrame=41,
hold=full`. The ledge is crossed at frame ~38. **Frame 41 is the last coyote
frame** — the maximum requires leaving the block entirely and jumping 3 frames
later. This is precisely the "one pixel left on the block" exploit.

### Jump-timing latitude is the difficulty metric

For runway=4 @60fps, taking the _best_ takeoff phase and measuring the longest
contiguous run of jump frames that clears the gap:

| gap (tiles) | working jump frames | latitude | tier                      |
| ----------: | ------------------: | -------: | ------------------------- |
|        5.00 |              12..41 |       30 | GUARANTEED                |
|        8.00 |              23..41 |       19 | GUARANTEED                |
|       10.00 |              31..41 |       11 | GUARANTEED                |
|       11.00 |              35..41 |        7 | NORMAL                    |
|       12.00 |              38..41 |        4 | NORMAL                    |
|       12.50 |              40..41 |        2 | EXPERT                    |
|       12.75 |              41..41 |        1 | **ULTRA (frame-perfect)** |
|       12.85 |              41..41 |        1 | **ULTRA (frame-perfect)** |
|       13.00 |                none |        0 | IMPOSSIBLE                |

This is the number to build difficulty on. It is monotonic, has a hard floor
at 0 (impossible) and a natural "0.1%" boundary at 1 (frame-perfect), and it
is directly interpretable: _how many frames of slop does the player get?_

---

## 3. Design

### 3.1 New module: `src/phaser/jumpSolver.ts`

Pure, Phaser-free, no dependency on `reachability.ts`. Owns one job: given a
jump situation, search the real input space and report what actually lands.

```ts
export type JumpTier = "GUARANTEED" | "NORMAL" | "EXPERT" | "ULTRA";

export interface JumpSituation {
  runwayTiles: number; // flat run-up before the ledge
  deltaYTiles: number; // + = target higher, - = target lower
  ceilingTiles?: number; // headroom over the runway; undefined = open sky
  landingWallTiles?: number; // solid height at the target's leading edge
}

export interface JumpSpectrum {
  guaranteedTiles: number; // latitude >= 10 frames
  normalTiles: number; // latitude >= 4
  expertTiles: number; // latitude >= 2
  ultraTiles: number; // latitude >= 1  <- the literal maximum
  impossibleTiles: number; // ultraTiles rounded up; nothing at/above lands
  /** Frames of jump-timing slop at each tier, for reporting. */
  latitude: Record<JumpTier, number>;
}

export function solveJump(s: JumpSituation): JumpSpectrum;
export function tierForGap(
  s: JumpSituation,
  gapTiles: number,
): JumpTier | "IMPOSSIBLE";
export function latitudeForGap(s: JumpSituation, gapTiles: number): number;
```

### 3.2 The simulator

Mirrors `PlayerController` + Arcade exactly, same order as the existing test
harness `Sim`, upgraded from a point to a real AABB:

1. `stepMovement(state, input, vx, vy, onGround, dt)` — verbatim, imported.
2. `vy = min(vy + GRAVITY_PX*dt, TERMINAL_VELOCITY_PX)`
3. `x += vx*dt; y += vy*dt`
4. Resolve collision for a `PLAYER_BODY_PX` (10×14) AABB against the takeoff
   platform, target platform, ceiling, and landing wall.

Grounded test is horizontal overlap with the takeoff platform, i.e. the body is
supported while `bodyLeft < ledgeX` — down to 1px of overlap. That is what
makes the exploit representable.

**Landing rule.** The jump clears gap `G` if, on the frame the body bottom
first crosses the target surface while descending, `bodyRight > targetLeft`.

**Side-clip guard.** When both the horizontal and vertical overlaps on that
frame are tiny, Arcade's least-penetration separation can eject the body
sideways instead of seating it on the tile — a real failure the naive rule
would score as a success. Require ≥1px of horizontal overlap at the crossing
frame and re-check the previous frame's position. Where the two disagree,
take the conservative answer and log it; this is the one place the model can
still drift from the engine, so §5 pins it with a Phaser integration test.

### 3.3 The search

For each `dt ∈ {1/30, 1/60, 1/144}`:

- **takeoff phase** `s ∈ [0, MAX_RUN_SPEED_PX·dt)` step 0.25px — covers every
  sub-frame alignment at the ledge.
- **jump frame** `jf ∈ [0, framesToLedge + coyoteFrames]`, plus `jf = -1`
  (never jump — a run-off can beat a jump for deep drops).
- **hold duration** `∈ {1, 2, 3, 5, 8, 12, 20, full}` — matters for low
  ceilings and rising targets, where a full jump clips its head.

Report the **minimum across the three frame rates** so a qualifying jump works
on every machine (per the frame-rate decision).

### 3.4 Cost and caching

The full sweep is ~10⁴–10⁵ sim runs per situation — tens of milliseconds, too
slow to run per tool call in a chat loop.

- Precompute a table at module load over `runwayTiles ∈ [0..8, 12, 20]` ×
  `deltaYTiles ∈ [-12..+7]` with open sky, and interpolate conservatively
  (round _down_) between rungs.
- The geometry-aware path (with a ceiling or landing wall) is off the table, so
  memoize on the situation key and solve lazily.
- Coarse-to-fine: binary-search the gap and only sweep the input space near the
  boundary, rather than sweeping every candidate gap.

Budget: table build < 500ms at load, cached lookup < 1ms, cold geometry-aware
solve < 50ms.

---

## 4. Integration

### 4.1 `calculateJumpGaps` tool — both modes

Keep the abstract signature for planning; add optional real geometry.

```ts
{
  runwayTiles: number,
  deltaYTiles: number,
  takeoffTile?: {x, y},   // if given, read real runway/ceiling/wall from scene
  targetTile?: {x, y},
  difficulty?: "EASY" | "NORMAL" | "HARD" | "BRUTAL",
}
```

Returns the full spectrum plus a `recommendedGapTiles` for the level's
difficulty, and — critically — `latitudeFrames` so the model can _explain_ why
a jump is hard. Description rewritten so Pewter stops treating one number as
"the" answer, and stops calling `Math.floor` on it (the tool now returns
already-rounded, tier-appropriate integers).

### 4.2 One engine everywhere

`MOVEMENT_CAPABILITIES` is rebuilt from `solveJump` instead of
`rawJumpDistanceTiles`. `reachability.ts` takes a difficulty parameter and uses
the matching tier's ladder. `movementPrompt.ts` renders the tier the level is
set to, and states the ULTRA numbers as the hard "never possible above this"
bound. `rawJumpDistanceTiles` and `calculateMaxGap` are deleted, not deprecated
— leaving them is how the split-brain comes back.

### 4.3 Difficulty dial

Level difficulty gates which tier Pewter may _require_ for progression:

| difficulty | max required tier | runway=4 budget |
| ---------- | ----------------- | --------------- |
| EASY       | GUARANTEED        | 10 tiles        |
| NORMAL     | NORMAL            | 12 tiles        |
| HARD       | EXPERT            | 12.5 tiles      |
| BRUTAL     | ULTRA             | 12.75 tiles     |

Optional/bonus routes (collectables, shortcuts) may exceed the level tier by
one step — that is what a secret is for.

`checkTraversal` / `verifyComplete` validate against the level's tier: a HARD
level passes if beatable at EXPERT, and reports its own rating as _the hardest
tier required on the critical path_ plus _how many near-max jumps are chained
consecutively_ (three EXPERT jumps in a row is harder than one, and nothing in
the current model can see that).

---

## 5. Tests

Extend `src/phaser/__tests__/playerPhysics.test.ts` and add
`jumpSolver.test.ts`:

1. **Monotonicity** — more runway never reduces any tier; every tier is ordered
   `GUARANTEED ≤ NORMAL ≤ EXPERT ≤ ULTRA`.
2. **Latitude semantics** — a gap at the GUARANTEED tier has ≥10 frames of
   slop; ULTRA has exactly 1; `impossibleTiles` has 0 at every frame rate.
3. **Regression floor** — the new numbers are never _below_ the old
   `calculateMaxGap` output. Under-reporting was the bug; over-correcting into
   under-reporting again is the regression to guard.
4. **Frame-rate safety** — anything at or below `guaranteedTiles` lands at all
   three rates.
5. **Coyote exploit is represented** — for runway ≥ 2, the optimal jump frame
   is strictly after the ledge frame. If this ever fails, the sim has lost the
   thing this rework exists to capture.
6. **Phaser integration test** (new, the important one) — drive a real Arcade
   body through a real tilemap at the solver's claimed ULTRA gap with the
   solver's claimed optimal inputs, and assert it lands. This is the only test
   that can catch the §3.2 side-clip modelling risk; everything above only
   proves the sim is self-consistent.

---

## 6. Phasing

Each phase is independently shippable and leaves the tree green.

- **P1 — `jumpSolver.ts` + tests, nothing wired.** Land the engine and the
  measured tables. Zero behaviour change.
- **P2 — Phaser integration test.** Validate the sim against the real engine
  before anything depends on it. If §3.2 is wrong, it is far cheaper to know
  here.
- **P3 — Rewire `calculateJumpGaps`** to the spectrum, both modes. Pewter gets
  correct numbers; reachability still on the old ladder (they now disagree in a
  _known_ direction — the tool is strictly more permissive).
- **P4 — Rebuild `MOVEMENT_CAPABILITIES`, `reachability.ts`,
  `movementPrompt.ts`** on the solver. Delete `calculateMaxGap` and
  `rawJumpDistanceTiles`. Split-brain closed.
- **P5 — Difficulty dial** through the tool schema, `checkTraversal`,
  `verifyComplete`, and level rating.

---

## 7. Risks

**The engine may not agree with the sim at the 1px boundary.** Arcade's
separation at simultaneous tiny x/y overlap is the least-certain part of the
model, and it is exactly where ULTRA lives. P2 exists to answer this before P3+
depend on it. If the engine disagrees, the fix is to shrink the landing rule's
tolerance, not to abandon the tier.

**ULTRA may not be humanly reachable.** A 1-frame window at 60fps is 16ms.
That is achievable but brutal, and it assumes a specific sub-pixel takeoff
phase the player cannot see. Treat BRUTAL as a design _ceiling_, not a target;
the honest human-hard tier is EXPERT.

**Widening the reachability ladder makes it less conservative.** Today a pass
means "genuinely beatable". After P4 a pass means "beatable at the level's
declared tier" — a weaker guarantee that is only safe because the tier is
explicit. EASY levels must keep using GUARANTEED so the old guarantee survives
where it matters.

**Retuning physics constants now invalidates a precomputed table**, not just a
formula. The table must be built at load from the live constants (never
checked in), so retuning still propagates automatically.
