# Pewter Physics Awareness — Implementation Plan

Goal (Parth, 2026-08-10): feed the tuned movement physics into the whole AI
ecosystem so Pewter (the LLM level designer) **knows exactly what levels are
possible**, and **defaults to challenging designs** — 5–6-block jumps rather
than trivial 1-block hops — unless the player explicitly asks for easier.

Physics source of truth: `src/phaser/playerPhysics.ts` (`PLAYER_PHYSICS`,
v2 tuning). Everything in this plan derives from it at runtime — **zero
hand-copied numbers anywhere in the LLM layer** — so future physics tuning
propagates automatically.

---

## 0. Current state (what's broken about Pewter's knowledge)

| Where                                   | Problem                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chatBox.ts:112` (active system prompt) | Hardcodes "jump approximately 6 tiles high", "1 tile wide and 1 tile tall", "1-tile gaps not traversable or fallable". No gap-vs-runway rules, no maximums, no difficulty policy. Numbers go stale on every retune (they already are: max gap is now ~11.7 tiles, and the 1-tile-gap claim was written for the old 32px-wide body — the unified 10×14px body **does** fit through a 1-tile gap). |
| `modelConnector.ts:54` (unused prompt)  | Says player is "2 tiles wide and 2 tiles tall" — contradicts the active prompt and reality. Dead code that will confuse the next person.                                                                                                                                                                                                                                                         |
| `verifyComplete` tool                   | Pure no-op — returns "✅ Verification confirmed" unconditionally. "The level must be completable" is enforced by nothing.                                                                                                                                                                                                                                                                        |
| `worldFacts` / `getWorldFacts` tool     | Reports structure (pitfalls, planes, staircases + heights) but nothing about traversability — Pewter can't ask "is this gap crossable".                                                                                                                                                                                                                                                          |
| Difficulty                              | No design policy at all. Pewter has no notion of "too easy".                                                                                                                                                                                                                                                                                                                                     |

## 1. The capability model (derived, not written)

### 1.1 New: `MOVEMENT_CAPABILITIES` in `src/phaser/playerPhysics.ts`

A derived object computed from `PLAYER_PHYSICS` via closed-form kinematics
(same math the simulation tests verify), **with a built-in safety margin**
so every "guaranteed" number survives imperfect play and discretization:

```ts
export const MOVEMENT_CAPABILITIES = deriveCapabilities(PLAYER_PHYSICS);
// {
//   playerSizeTiles: { w: 0.63, h: 0.88 },   // from the 10×14px body
//   maxJumpHeightTiles: 6.3,                 // apex
//   maxStepUpTiles: 5,                       // guaranteed climbable ledge (6 = frame-perfect)
//   standingGapTiles: 5,                     // guaranteed from zero runway (raw ~5.4)
//   maxGapTiles: 11,                         // guaranteed with full runway (raw ~11.7)
//   gapForRunway: [ {runway: 0, gap: 5}, {runway: 1, gap: 8},
//                   {runway: 2, gap: 9}, {runway: 4, gap: 10},
//                   {runway: 7, gap: 11} ],  // conservative ladder
//   impossibleGapTiles: 12,                  // ≥ this is NEVER crossable
//   impossibleWallTiles: 7,                  // ≥ this is NEVER climbable
//   stopDistanceTiles: 2,                    // landing precision headroom
//   fallsThroughOneTileGap: true,            // body is narrower than a tile — VERIFY in-game (§5)
// }
```

Derivation notes:

- Gap(runway) is **√-shaped**: takeoff speed = √(2·GROUND_ACCEL·runway),
  capped at MAX_RUN_SPEED, then flight distance integrates AIR_ACCEL over
  the fixed ~0.73s airtime. Raw values: 0→5.4, 1→9.4, 2→10.5, 4→11.4,
  6.4+→11.7 tiles. The ladder above rounds DOWN ~0.5–1 tile for safety.
- `maxStepUpTiles`: apex is 6.3, but clearing a 6-tile ledge leaves 0.3
  tiles of margin — playable but tight. Guaranteed = 5, "expert" = 6.
- **Cross-check test** (new, in `playerPhysics.test.ts`): every entry in
  `gapForRunway` must be crossable in the frame-accurate `Sim` from the
  existing test suite, and `impossibleGapTiles` must fail even with
  maximum runway. The closed form can never drift from real physics.

### 1.2 New: `src/languageModel/movementPrompt.ts`

`buildMovementPromptSection(): string` — renders `MOVEMENT_CAPABILITIES`
into the prose Pewter reads. Roughly:

> MOVEMENT FACTS (derived from live game physics — trust these exactly):
> The player is smaller than 1 tile (fits through any 1-tile opening, and
> WILL fall through a 1-tile-wide gap in the floor). Max jump height: can
> reliably climb ledges up to 5 tiles; 6 is the absolute maximum; 7+ is
> IMPOSSIBLE. Horizontal gaps: up to 5 tiles crossable from a standstill;
> 6–8 tiles need at least 1 tile of flat run-up before the edge; 9–10 need
> 2–4 tiles of run-up; 11 needs 7+ tiles of run-up; **12 or wider is
> IMPOSSIBLE — never require one**. The player needs ~2 tiles to stop after
> landing at speed — don't put hazards flush against far landing edges
> unless that's the intended challenge.

And a companion `buildDesignPolicySection(): string` (§2).

## 2. Default difficulty policy — "challenging unless told otherwise"

New: `src/languageModel/designPolicy.ts` — policy constants + prompt text,
separate from physics so difficulty is tunable without touching movement:

```ts
export const DESIGN_POLICY = {
  defaultGapRangeTiles: [4, 6], // bread-and-butter mandatory jumps
  defaultStepUpRangeTiles: [3, 5],
  maxTrivialJumpsPercent: 20, // 1–2-tile hops = connective tissue only
  maxFlatRunTiles: 8, // no unchallenged walking longer than this
  expertMovesRequireOptIn: true, // 6-tile step-ups / 11-tile gaps only if asked
} as const;
```

Prompt section (generated from the above):

> DESIGN DIFFICULTY (default: challenging-but-fair): Unless the player asks
> for an easy/kid-friendly level, design near the player's limits. Mandatory
> jumps should mostly be 4–6-tile gaps and 3–5-tile climbs — never design a
> challenge around a 1–2-tile hop; use those only to connect sections. Avoid
> flat safe stretches longer than ~8 tiles; interrupt them with a gap,
> height change, enemy, or hazard. Combine mechanics (a gap after a climb, a
> coin over a pit) rather than repeating one jump. Reserve maximum-skill
> moves (6-tile climbs, 10–11-tile gaps) for moments the player asked to be
> hard, and NEVER exceed the movement facts above. When the player names a
> difficulty ("make it easy", "brutal"), that overrides this default.

Both sections are concatenated into `sysPrompt` in `chatBox.ts`, replacing
the current hardcoded sentence at line 112. The rest of the prompt is
untouched.

## 3. Real completability checking (kill the no-op)

The biggest gap: nothing verifies Pewter's output. Plan:

### 3.1 New: `src/languageModel/reachability.ts`

A deterministic tile-graph reachability checker, pure and unit-testable:

- **Nodes**: "standable" cells — solid tile with enough empty headroom for
  the sub-1-tile body (1 clear tile suffices).
- **Edges**: walk (adjacent standable, includes 1-tile step up/down since
  that's within trivial jump), fall (off an edge, any height — no fall
  damage exists), jump (target within the capability envelope given the
  **actual runway available on the takeoff platform**, from
  `MOVEMENT_CAPABILITIES.gapForRunway` + `maxStepUpTiles`).
- **API**:
  `checkReachability(grid, from) → { reachable: Set<cell>, diagnoses: [] }`
  where each diagnosis names the blocker in Pewter's own vocabulary:
  `"gap x=12..25 (13 tiles) exceeds the 11-tile maximum"`,
  `"wall at x=30 is 8 tiles — max climbable is 6"`,
  `"gap x=40..48 (9 tiles) needs 2 tiles of run-up but the platform has 1"`.
- Conservative by construction (uses the safety-margin ladder, not raw
  physics), so a pass means genuinely beatable.

### 3.2 Wire it into the tool loop

1. **`verifyComplete` becomes real**: before returning, it runs
   `checkReachability` over the current map (spawn → all collectables +
   right edge of the selection / goal). On failure it returns the
   diagnoses as an error string instead of "✅" — Pewter has up to 8 tool
   rounds and will fix and re-verify within the same request. On success,
   unchanged behavior.
2. **New read-only tool `checkTraversal`** (same engine, callable early) so
   Pewter can validate a plan before placing 50 tiles, and answer player
   questions like "is my level beatable?". Add to `READ_ONLY_TOOLS` in
   `chatBox.ts` so it doesn't trigger snapshots.

### 3.3 Difficulty floor (stretch, optional)

The checker already computes, for the easiest path, the largest mandatory
gap/climb. Report it in `verifyComplete`'s success message ("hardest
mandatory move: 5-tile gap") so Pewter can notice it built something
trivial and iterate toward `DESIGN_POLICY.defaultGapRangeTiles`. Advisory
only — no hard failure for "too easy". Cut this if time is tight.

## 4. Traversal facts in `worldFacts` (situated awareness)

Extend `worldFacts.ts` structure analysis with a `Traversal` category
exposed through the existing `getWorldFacts` tool: for each detected gap /
height change, emit a fact phrased against capabilities:

> "Gap from x=10 to x=17 (7 tiles): crossable with ≥1 tile of run-up; the
> platform to its left provides 4 tiles."
> "Ledge at x=22 is 6 tiles tall: expert-only climb (max is 6)."

This is what lets Pewter reason about _existing_ maps it didn't build.
Medium effort; independent of §§1–3 and can ship after them.

## 5. Consistency sweep (small but important)

- **Verify the 1-tile-gap claim in-game** (one manual playtest): with the
  10×14px body, walk over a 1-tile floor gap → confirm the player falls
  through. Set `fallsThroughOneTileGap` accordingly; the prompt text and
  reachability edges both read it. (The old prompt asserted the opposite.)
- **Delete the stale prompt block in `modelConnector.ts`** (it's marked
  UNUSED; the contradictory "2 tiles wide/tall" line dies with it). If the
  file must stay importable, keep the connector code and remove only the
  prompt string.
- `generateEnemy` / CEDL mention jump actions with `max_height` params —
  out of scope here (enemy physics ≠ player physics; gravity fix already
  landed), but note in code comments that enemy reachability uses
  `TerrainAwareness`, not `MOVEMENT_CAPABILITIES`.

## 6. Tests & acceptance criteria

New/updated tests (vitest, alongside the existing 20):

1. **Capability ↔ simulation cross-check** (§1.1): every `gapForRunway`
   rung crossable in `Sim`; `impossibleGapTiles` and `impossibleWallTiles`
   fail in `Sim` even under ideal play.
2. **Prompt derivation**: `buildMovementPromptSection()` contains the
   derived numbers (regex-match against `MOVEMENT_CAPABILITIES`) — fails if
   anyone re-hardcodes.
3. **Reachability engine**: toy grids — flat walk; 5-tile gap from
   standstill (pass); 9-tile gap with 1-tile runway (fail) vs 2-tile runway
   (pass); 12-tile gap with infinite runway (fail); 5 vs 7-tile wall;
   fall-only path (pass); fully-blocked map (fail with correct diagnosis).
4. **verifyComplete integration**: mocked scene grid — uncompletable map
   returns diagnoses, completable map returns success.

Acceptance (manual): ask Pewter for "a level" with an empty prompt → it
should produce mandatory 4–6-tile jumps, no challenge built on 1-block
hops, and `verifyComplete` should pass on the first or second round. Ask
for "an easy level" → small gaps return. Ask for "impossible 15-tile gap"
→ Pewter refuses/adjusts, citing the 11-tile maximum.

## 7. Implementation order

Each step ships independently; commit per step.

1. `MOVEMENT_CAPABILITIES` + cross-check tests (pure math, no UI risk).
2. `movementPrompt.ts` + `designPolicy.ts` + swap into `chatBox.ts`;
   delete `modelConnector.ts` stale prompt. (Pewter is already smarter.)
3. In-game verification of the 1-tile-gap fact; set the flag.
4. `reachability.ts` + unit tests.
5. Wire `verifyComplete` + add `checkTraversal` tool.
6. `worldFacts` Traversal category (§4).
7. (Stretch) difficulty floor reporting (§3.3).

Estimated size: steps 1–2 small (the leverage step); 4–5 the main build
(~a day of focused work); 3 and 6 medium; 7 small.

## 8. Out of scope

- Retuning physics further (if gap-vs-runway should be steeper — i.e.
  runway mattering MORE — lower `AIR_ACCEL`; flagged, not planned).
- Enemy-side capability modeling (TerrainAwareness already fixed).
- Difficulty as a player-facing UI setting (policy stays prompt-level).
- Multi-jump path planning beyond single-jump edges (wall jumps, chained
  precision sequences) — the single-jump graph is sufficient for
  completability, conservative for difficulty.
