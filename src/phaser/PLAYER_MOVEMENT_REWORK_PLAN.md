# Player Movement Rework — Implementation Plan

Decisions locked in with Parth (2026-08-10):

| Decision | Choice |
|---|---|
| Acceleration model | **Snappy linear acceleration** (true px/s², ~0.27s to top speed) — replaces exponential smoothing |
| Frame-rate independence | **Delta-based** (pass Phaser's real `delta` into the formulas; no fixed-step accumulator) |
| Units | **Tiles + seconds everywhere** — constants defined in tiles/s, tiles/s², tiles; converted to px once at the boundary |
| Compatibility | **Preserve key numbers**: max jump height, standing-jump gap, top speed, ground stop distance |
| Structure | **Shared PlayerController** consumed by both `gameScene` and `editorScene` playtest |
| Adjacent fixes | TerrainAwareness gravity bug; body-size + sprite-flip mismatches between scenes |
| Feel additions | **Coyote time** (~90ms) + **jump buffering** (~100ms) |
| Sprite facing | Verify from the spritesheet art during implementation; make both scenes consistent |
| Out of scope | Syncing the LLM system-prompt numbers (`chatBox.ts` / `modelConnector.ts`) — deliberately deferred |

Background/analysis: see `PLAYER_CONTROLLER_PHYSICS.md` and
`PLAYER_MOVEMENT_DEEP_DIVE.md`. This plan supersedes the "open question" in
those docs: the answer is **interpretation 2 — literal linear acceleration
was the intent**, and we are switching to it.

---

## 1. Problems being fixed (recap)

1. **Frame-rate dependence.** `handlePlayerMovement()` hardcodes `(1/60)` as
   the timestep (`gameScene.ts:320,335,343`); `update()` ignores Phaser's
   `delta`. Horizontal feel literally changes with the player's monitor/CPU.
2. **Two conflicting math models under near-identical names.**
   `ACCELERATION = 1500` is consumed as exponential smoothing (% of remaining
   gap per frame → ~2s to top speed); `FRICTION = 1200` is consumed as literal
   px/s². Same naming style, different physics.
3. **Pixel units with no tile grounding.** All constants are world-px values;
   every level-design question requires dividing by 16 by hand.
4. **Wholesale duplication.** `editorScene.ts:1244-1315` is an independent
   copy of the whole controller (constants at 1261-1265). Already drifting:
   the two copies **flip the sprite in opposite directions** for the same
   input (`gameScene.ts:307-313` flips on right; `editorScene.ts:1253-1259`
   flips on left), and only the editor sets a physics body size
   (`editorScene.ts:1020` `setSize(10,14).setOffset(3,1)`; `gameScene.ts`
   never calls `setSize`, so real-game collisions use the full frame).
5. **Wrong gravity in enemy AI.** `TerrainAwareness.calculateJumpToTarget`
   defaults `gravity = 800` (`TerrainAwareness.ts:462`); the world uses 1500.
   The one call site (`DynamicEnemy.ts:443`) relies on the wrong default.
6. **Dead/misleading code.** `setMaxVelocity(PLAYER_SPEED * 1.2, 800)`
   (`gameScene.ts:170`) — the ×1.2 horizontal ceiling is unreachable dead
   code (manual clamp caps at 400 first) and the 800 vertical terminal
   velocity is an unnamed magic number. Air friction's `0.3` is an unnamed
   literal. The commented-out VFX emitters make `startWalkingVFX`/
   `startJumpVFX` permanent no-ops.
7. **Missing standard feel features.** No coyote time, no jump buffering.

---

## 2. Target design

### 2.1 New constants — all in tiles and seconds

One new module (see §3) owns every number. `TILE = 16` px is the only
conversion factor, applied once.

```ts
export const TILE = 16; // world px per tile — the ONLY px conversion

export const PLAYER_PHYSICS = {
  // Speed & acceleration (tiles/s, tiles/s²)
  MAX_RUN_SPEED: 25,        // = 400 px/s (preserved)
  GROUND_ACCEL: 93.75,      // = 1500 px/s² → 0→max in ~0.27s, ~3.3 tiles of runway
  GROUND_FRICTION: 75,      // = 1200 px/s² (preserved) → stop from max in 0.33s / ~4.1 tiles
  AIR_ACCEL: 23.4,          // = ~375 px/s² — tuned to preserve the ~6.1-tile standing jump (§2.3)
  AIR_FRICTION: 22.5,       // = 360 px/s² (preserved; was the unnamed FRICTION * 0.3)

  // Vertical (tiles, tiles/s, tiles/s²)
  GRAVITY: 93.75,           // = 1500 px/s² (preserved)
  JUMP_HEIGHT: 6.3,         // tiles, full-hold apex (preserved: derives v₀ ≈ 550 px/s)
  TERMINAL_VELOCITY: 50,    // = 800 px/s max fall speed (was the unnamed setMaxVelocity y)

  // Jump modifiers (dimensionless / s / tiles/s)
  JUMP_CUT_MULTIPLIER: 0.4, // preserved: release early → upward velocity × 0.4
  JUMP_CUT_MIN_SPEED: 3.125,// = 50 px/s: no cut once slower than this upward
  COYOTE_TIME: 0.09,        // s — NEW: grace period to jump after leaving a ledge
  JUMP_BUFFER: 0.1,         // s — NEW: early jump press queued until landing
} as const;

// Derived once, in px, next to the definitions — never hand-computed elsewhere:
export const JUMP_VELOCITY_PX =
  -Math.sqrt(2 * PLAYER_PHYSICS.GRAVITY * TILE * PLAYER_PHYSICS.JUMP_HEIGHT * TILE);
// = -√(2 · 1500 · 100.8) ≈ -550 px/s — matches today's -550 by construction
```

Key point: **jump velocity is no longer a tuned constant** — it's derived
from `JUMP_HEIGHT` (design intent) and `GRAVITY`. Tuning jump height means
editing a number that *is* the number of tiles.

### 2.2 New movement model — linear, delta-based

Everything below runs in `PlayerController.update(dt)` where
`dt = Math.min(delta / 1000, 1/30)` seconds (clamped so a tab-switch or GC
spike can't produce a giant step that tunnels through tiles).

```ts
// Horizontal — one moveTowards, used for BOTH accelerating and stopping:
const target = moveInput * MAX_RUN_SPEED_PX;          // moveInput ∈ {-1, 0, 1}
const rate = moveInput !== 0
  ? (onGround ? GROUND_ACCEL_PX : AIR_ACCEL_PX)       // accelerating toward ±max
  : (onGround ? GROUND_FRICTION_PX : AIR_FRICTION_PX);// decelerating toward 0
velocityX = moveTowards(velocityX, target, rate * dt);

function moveTowards(v: number, target: number, maxDelta: number) {
  return Math.abs(target - v) <= maxDelta ? target : v + Math.sign(target - v) * maxDelta;
}
```

This collapses today's four branches (exponential accel, ±5px snap window,
ground friction, air friction) into one uniform, honest formula. The
`Clamp(±PLAYER_SPEED)` stays as a safety net for external impulses
(knockback etc.), but `moveTowards` can never overshoot on its own.

```ts
// Vertical — jump with coyote time + buffering:
if (onGround) coyoteTimer = COYOTE_TIME; else coyoteTimer -= dt;
if (jumpJustPressed) bufferTimer = JUMP_BUFFER; else bufferTimer -= dt;

if (bufferTimer > 0 && coyoteTimer > 0) {
  velocityY = JUMP_VELOCITY_PX;
  bufferTimer = 0;
  coyoteTimer = 0;            // no double-jump from the same grace window
  hooks.onJump?.();           // scene-provided VFX callback
}
// Jump-cut (unchanged mechanic, same numbers):
if (jumpReleased && velocityY < -JUMP_CUT_MIN_SPEED_PX) {
  velocityY *= JUMP_CUT_MULTIPLIER;
}
```

`jumpJustPressed` uses `Phaser.Input.Keyboard.JustDown` semantics (edge
detection), replacing the hand-rolled `isJumpPressed` latch. Gravity and
terminal velocity remain Phaser Arcade's job (`world.gravity.y` set from
`GRAVITY` × `TILE`; `setMaxVelocity` y from `TERMINAL_VELOCITY` × `TILE`) —
Arcade already integrates against real delta.

Input handling is preserved as-is: arrows + WASD, digital -1/0/+1, left wins
if both held.

### 2.3 Preserved numbers, and how they're preserved

| Metric | Today (60fps) | After rework | How |
|---|---|---|---|
| Top run speed | 400 px/s (25 t/s) | **same** | `MAX_RUN_SPEED = 25` |
| Full-hold jump apex | ~6.3 tiles (v₀ 550, g 1500) | **same** | `JUMP_HEIGHT = 6.3` derives v₀ ≈ 550 |
| Tap-jump minimum | ~1.4 tiles | ~same | same jump-cut multiplier/threshold |
| Standing-jump gap (hold forward from 0 speed) | ~6.1 tiles | **~6.1 tiles** | `AIR_ACCEL ≈ 23.4 t/s²`: from standstill, ½·375·(0.73s)² ≈ 98px ≈ 6.1 tiles |
| Full-runway jump gap | ~17.9 tiles | ~18.3 tiles | 400 px/s × full airtime; +0.4 tile from removing frame quantization — accepted |
| Ground stop distance from max | ~4.1 tiles | **same** | `GROUND_FRICTION = 75 t/s²` unchanged |
| Time/runway to top speed | ~2s / ~34 tiles | **0.27s / ~3.3 tiles** | the intended "snappy" change |

**The deliberate trade-off to be aware of:** because reaching top speed now
takes ~3.3 tiles instead of ~34, *short-runway jumps get much longer*. Today
a jump after a 10-frame approach covers ~8.7 tiles; after the rework almost
any approach with ≥4 tiles of runway covers the full ~18. The standing jump
(~6.1 tiles) is preserved as the floor. Any existing level that used short
runways to gate a gap between ~9 and ~18 tiles becomes easier. This is
inherent to "snappy" and was accepted in the compat decision, but playtest
existing levels after the switch (§6).

`AIR_CONTROL = 0.8` disappears as a concept: it never matched perceived air
control anyway (it scaled only accel, not friction, and the docs flagged the
confusion). It's replaced by two explicit constants, `AIR_ACCEL` and
`AIR_FRICTION`, both independently tunable in tile units.

---

## 3. New architecture

### 3.1 New file: `src/phaser/playerController.ts`

```ts
export const TILE = 16;
export const PLAYER_PHYSICS = { ... };           // §2.1
export const JUMP_VELOCITY_PX = ...;             // derived
export const GRAVITY_PX = PLAYER_PHYSICS.GRAVITY * TILE; // = 1500, exported for reuse

export interface PlayerControllerHooks {
  onJump?: () => void;        // gameScene: startJumpVFX
  onWalk?: () => void;        // gameScene: startWalkingVFX
  onStopWalking?: () => void; // gameScene: vfx.walking.stop
}

export class PlayerController {
  constructor(
    scene: Phaser.Scene,
    player: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody,
    hooks?: PlayerControllerHooks,
  ) { /* creates cursors + WASD keys itself */ }

  update(deltaMs: number): void;  // the entire §2.2 model
  get onGround(): boolean;
  get isFalling(): boolean;       // kept, exposed as a getter instead of sprite mutation
  reset(): void;                  // zero velocity + timers (used on respawn/death)
}

/** One place that configures the sprite the same way in both scenes. */
export function configurePlayerSprite(player: SpriteWithDynamicBody): void {
  player.setScale(2);
  player.setSize(10, 14).setOffset(3, 1); // editor's body, now used everywhere
  player.setDrag(0, 0);
  player.setMaxVelocity(
    PLAYER_PHYSICS.MAX_RUN_SPEED * TILE,      // honest cap, replaces dead ×1.2
    PLAYER_PHYSICS.TERMINAL_VELOCITY * TILE,
  );
}
```

Deliberately **not** in the controller: death/health, fall-off-the-map
handling, respawn position, camera. Those stay scene-owned because the two
scenes intentionally differ (gameScene teleports with no penalty,
`gameScene.ts:387-391`; editorScene deducts health and calls
`resetPlayLevel()`, `editorScene.ts:1232-1238`).

### 3.2 `gameScene.ts` changes

- Delete the five constants (35-39), `isJumpPressed`, and the entire body of
  `handlePlayerMovement()` (297-392) except the fall-off check, which moves
  into `update()`.
- `update()` becomes `update(time: number, delta: number)` and calls
  `this.controller.update(delta)`.
- Player creation uses `configurePlayerSprite()` (fixes the missing
  `setSize` — **note: this shrinks the real game's hitbox to match the
  editor's**, which is a gameplay-visible fix: the player will fit through
  1-tile gaps the same way in both modes).
- `world.gravity.y` and the duplicate `setScale(2)` (line 189) come from the
  shared module / helper.
- VFX calls move into hooks: `onJump`, `onWalk`, `onStopWalking`. (The
  commented-out emitter setup at 210-230 stays as-is — reviving VFX is out
  of scope — but the hook wiring means uncommenting it later Just Works.)

### 3.3 `editorScene.ts` changes

- Delete the inline movement block (`~1244-1315`) and the duplicated
  constants (1261-1265); replace with `this.controller.update(delta)` inside
  the existing `gameActive` branch. `update()` gains `(time, delta)` params.
- Construct the controller when play mode starts (where the player sprite is
  created, near line 1020) and call `controller.reset()` in
  `resetPlayLevel()`; gravity setup (line 314) switches to `GRAVITY_PX`.
- Player setup swaps to `configurePlayerSprite()` (it already had the
  setSize; now it's shared).

### 3.4 Sprite flip fix

At implementation time, open the spritesheet (`'spritesheet'` frame 14) and
determine the art's default facing. Encode it once in the controller:
`player.setFlipX(moveInput === -1 ? A : B)` with a single
`SPRITE_FACES_RIGHT` boolean in the constants. Both scenes stop disagreeing
by construction. (Quick check: run the game, walk right, see if the
character walks backwards.)

### 3.5 `TerrainAwareness.ts` + `DynamicEnemy.ts` fix

- `calculateJumpToTarget(..., gravity: number = 800)` → remove the wrong
  default; import `GRAVITY_PX` from `playerController.ts` as the default (or
  make the param required and pass `scene.physics.world.gravity.y` at the
  call site in `DynamicEnemy.ts:443` — preferred, since editor mode toggles
  gravity 0↔1500 and a live read is always right).
- Audit the rest of TerrainAwareness for other uses of the 800 assumption
  (`grep -n 800` the file) while in there.

---

## 4. Verification: lock the numbers in with a simulation test

Before touching the scenes, port the doc's methodology into a committed
test so "preserve key numbers" is enforced, not eyeballed:

- `src/phaser/__tests__/playerPhysics.test.ts` (use the repo's existing
  test runner if one exists; otherwise add `vitest` as a dev dependency —
  it's the standard for Vite projects — with a single `npm run
  test:physics` script).
- The test steps the **new** controller math (the pure functions — extract
  `moveTowards` + the jump math so they're testable without Phaser) and
  asserts, at dt = 1/60, dt = 1/30, and dt = 1/144:
  1. Full-hold jump apex = 6.3 tiles ± 0.1 (all frame rates)
  2. Standing-jump gap = 6.1 tiles ± 0.3 (all frame rates)
  3. Top speed exactly 25 tiles/s, reached in ≤ 0.3s from rest
  4. Ground stop distance from max = 4.1 tiles ± 0.2
  5. Tap-jump minimum ≈ 1.4 tiles ± 0.2
  6. **Cross-rate agreement:** results at 30/60/144fps within 2% of each
     other (the actual frame-rate-independence proof)
  7. Coyote: jump input 80ms after walking off a ledge still jumps; 120ms
     after does not
  8. Buffer: jump pressed 80ms before landing fires on the landing frame

---

## 5. Implementation order

Each step leaves the game runnable; commit per step.

1. **Constants + pure math module** (`playerController.ts`: `TILE`,
   `PLAYER_PHYSICS`, derived values, `moveTowards`, pure step functions).
2. **Simulation tests** (§4) against the pure math — red/green the tuned
   `AIR_ACCEL` value here until the standing-jump target passes.
3. **`PlayerController` class** wrapping the pure math with Phaser input +
   body plumbing, plus `configurePlayerSprite()`.
4. **Wire `gameScene`** (§3.2). Manual smoke test: run, jump, fall off map.
5. **Wire `editorScene`** playtest (§3.3). Manual smoke test: build → play →
   die → reset.
6. **Flip + hitbox verification** (§3.4): confirm art facing, confirm
   effective body size at runtime (`console.log(player.body.width/height)`
   once in dev — the docs flagged uncertainty about whether Arcade scales
   `setSize` by the 2× display scale; resolve it empirically and note the
   answer in the code comment).
7. **TerrainAwareness/DynamicEnemy gravity fix** (§3.5).
8. **Docs**: mark `PLAYER_CONTROLLER_PHYSICS.md` and
   `PLAYER_MOVEMENT_DEEP_DIVE.md` as describing the OLD system (banner at
   top pointing here), or rewrite their cheat-sheet tables with the new
   derived numbers.

## 6. Manual QA checklist (after step 5)

- [ ] Feel: running starts/stops feel snappy, not floaty; no visible "snap" at top speed
- [ ] Jump heights: tap ≈ 1.5 tiles, full hold clears a 6-tile wall, fails a 7-tile wall
- [ ] Standing jump clears a 5-tile gap, fails an 8-tile gap
- [ ] Coyote: can jump just after running off a ledge; buffer: mashing jump right before landing feels responsive
- [ ] Editor playtest and real game feel identical (same body, same constants, same flip)
- [ ] Throttle the tab / use a 144Hz monitor if available: movement speed and jump distances unchanged
- [ ] Existing levels still completable (expect mid-length gaps to be *easier*, per §2.3 — flag any that become trivial)
- [ ] Enemies with jump AI still path sensibly (gravity fix changes their computed arcs)

## 7. Explicitly out of scope (deferred)

- LLM system-prompt sync (`chatBox.ts` "6 tiles high" / player-size
  contradiction with `modelConnector.ts`) — user deselected; revisit after
  the physics lands so the prompt can be derived from `PLAYER_PHYSICS`.
- Reviving the dust-particle VFX (hooks are wired ready for it).
- Unifying fall-off-map behavior between scenes (intentional difference).
- Analog/gamepad input, variable-strength input.
