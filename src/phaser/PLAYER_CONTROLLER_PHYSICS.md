# Player Controller Physics — What the Constants Actually Mean

Source of truth: `gameScene.ts:35-39`, consumed in `handlePlayerMovement()`
(`gameScene.ts:297-392`). The exact same five literals are duplicated
independently in `editorScene.ts:1261-1265` for in-editor playtesting — see
[Known inconsistencies](#known-inconsistencies-found-while-researching-this)
below.

```ts
private readonly PLAYER_SPEED = 400;   // Player run speed
private readonly JUMP_VELOCITY = -550; // Player jump height
private readonly ACCELERATION = 1500;  // Rate the player gets to max speed
private readonly FRICTION = 1200;      // Rate the player slows down
private readonly AIR_CONTROL = 0.8;    // % of ground control while in the air
```

Plus one constant that lives elsewhere but is required to make sense of the
other five: `physics.world.gravity.y = 1500` (`gameScene.ts:141`).

This doc explains, for each constant: what unit the in-line comment implies,
what unit the code *actually* implements, and what that means in real,
tile-based level-design terms. All derived numbers below were checked with a
frame-accurate simulation of the exact formulas in `handlePlayerMovement()`
(60fps, 16px tiles), not hand-wavy kinematics — see
[Methodology](#methodology) at the bottom.

**This is documentation only — no code was changed.**

---

## 1. World units, first

- **Tile size:** 16×16 world px (`addTilesetImage(..., 16, 16, ...)` in both
  `gameScene.ts` and `editorScene.ts`). The camera zoom (`setZoom(2.25)`) and
  sprite render scale (`player.setScale(2)`) are purely visual — they do not
  change world-space physics units. All px values in this doc are **world
  px**, i.e. divide by 16 to get tiles.
- **Frame rate assumption:** `physics.world.gravity.y` is applied by Phaser's
  Arcade engine using the real elapsed frame delta, so vertical motion is
  frame-rate independent. **Horizontal motion is not.** `handlePlayerMovement()`
  hardcodes `(1/60)` as the timestep instead of using Phaser's `delta`
  parameter (which `update()` doesn't even accept — see `gameScene.ts:283`).
  Every number in this doc assumes a steady 60fps, matching what the code
  itself assumes. At a different frame rate, horizontal acceleration/friction
  will run faster or slower than intended while jump height/gravity will not.

---

## 2. Constant-by-constant

### `PLAYER_SPEED = 400`
**Comment says:** run speed. **Code does:** exactly that — a literal velocity
cap in **px/s**. It's the target value both the ground-acceleration and
air-acceleration formulas lerp toward, and it's also the hard clamp
(`Phaser.Math.Clamp(velocityX, -PLAYER_SPEED, PLAYER_SPEED)`) applied every
frame regardless of state. Nothing surprising here.

*(Aside: `setMaxVelocity(PLAYER_SPEED * 1.2, 800)` at `gameScene.ts:170` sets
a separate, higher ceiling of 480px/s — but since the manual clamp above
already caps horizontal velocity at 400, that 480 ceiling is currently dead
code for normal movement; it would only matter if some other system (e.g.
knockback) pushed velocity past 400 without going through this clamp.)*

### `ACCELERATION = 1500` — ⚠️ the confusing one
**Comment says:** "Rate the player gets to max speed," phrased like a
standard acceleration in px/s². **Code does something different.** The actual
formula (`gameScene.ts:320`):

```ts
velocityX += (targetVelocity - velocityX) * (acceleration / 1000) * (1/60);
```

This is **exponential smoothing toward the target velocity**, not constant
acceleration. Each frame, velocity closes the *remaining gap* to
`PLAYER_SPEED` by a fixed fraction — `(1500/1000) * (1/60) = 2.5%` per frame
on the ground — rather than gaining a fixed amount. That produces an
asymptotic curve, not a ramp: you get most of your speed quickly, then spend
a long tail slowly creeping toward the last few px/s.

If you read "1500" as literal px/s² (a natural reading of the name and
comment), you'd expect max speed in `400/1500 ≈ 0.27s`. That is **not** what
happens. Simulated, starting from a dead stop on flat ground:

| Time held | Frame | % of max speed (400) |
|---|---|---|
| 0.17s | 10 | 22% |
| 0.50s | 30 | 53% |
| 1.00s | 60 | 78% |
| 2.00s | 119 | 95% |
| 3.33s | 200 | 100% (snaps once within 5px/s) |

Reaching ~95% of max run speed takes **~2 seconds and ~34 tiles of flat,
uninterrupted runway** (see the run-up sweep in
[§3](#3-derived-level-design-numbers)). This is the constant most likely to
surprise anyone reasoning about the game from the variable name alone.

**Open question for the team** (not resolved by this doc — needs a decision,
not a doc fix): is this the intended feel, or is `(1/60)` an accidental
double-application of a timestep that was already baked into `/1000`? Two
plausible original intents:
1. **As coded** — deliberately floaty acceleration, ~2s to top speed. Keep it,
   and treat "ACCELERATION" as a misnomer for "closing-rate constant," not a
   literal px/s².
2. **Literal linear acceleration was intended** — `velocityX +=
   Math.sign(target - velocityX) * ACCELERATION * dt`, which would reach max
   speed in a snappy `400/1500 ≈ 0.27s` (16 frames), a much more typical
   platformer feel. This is a different formula, not just different units.

Any level-reachability math (minimum runway before a jump, etc.) is only
valid for whichever interpretation the game actually ships with — flag this
before building automated reachability checks on top of it.

### `FRICTION = 1200`
**Comment says:** "Rate the player slows down." **Code does:** exactly that —
unlike `ACCELERATION`, this *is* literal deceleration in **px/s²**
(`gameScene.ts:335-338`): `velocityX -= sign(velocityX) * (FRICTION * dt)`,
a fixed amount subtracted every frame. So the two "rate" constants in this
file use genuinely different mathematical models despite near-identical
naming/phrasing — that inconsistency is itself worth knowing about.

From max speed (400px/s) on the ground: stops in **20 frames (0.33s)**,
covering **~63px (~4 tiles)**.

In the air (no horizontal input), friction is `FRICTION * 0.3` — a separate,
unnamed literal `0.3` hardcoded at `gameScene.ts:343`, not tied to
`AIR_CONTROL`. Air deceleration is 360px/s²: from max speed that's 1.11s
to fully stop (~222px / ~14 tiles), but a full jump only lasts ~0.72s, so in
practice a jump never fully sheds momentum from air friction alone.

### `AIR_CONTROL = 0.8`
**Comment says:** "% of ground control while in the air." **Code does:** a
dimensionless multiplier (0–1) applied *only* to `ACCELERATION` while
airborne (`gameScene.ts:316`): `acceleration = onGround ? ACCELERATION :
ACCELERATION * AIR_CONTROL`. It does **not**:
- reduce the top speed reachable in the air (still clamped to `PLAYER_SPEED`)
- affect air friction/deceleration (that's the separate hardcoded `0.3`
  described above)

So "how much control you have in the air" is actually governed by two
independent, differently-scoped numbers — only one of which (`AIR_CONTROL`)
is an actual named constant. Worth remembering if either is ever tuned in
isolation, since changing one without the other only affects half of "air
control" as a player would perceive it.

### `JUMP_VELOCITY = -550`
**Comment says:** "Player jump height." **Code does:** a literal
**instantaneous vertical velocity impulse**, in px/s, applied once on the
frame the jump starts (`gameScene.ts:361`), while `onGround` is true and the
jump key transitions from up to down. Negative because Phaser's Y axis
increases *downward*, so negative velocity is upward.

This single number, combined with `gravity.y = 1500` (not one of the 5 lines,
but essential — set at `gameScene.ts:141`), fully determines jump height and
airtime via standard projectile motion (Arcade physics integrates gravity
correctly against real delta time, so this part *is* frame-rate independent).

There's also a **variable jump height** mechanic layered on top
(`gameScene.ts:366-369`): if the jump key is released while still ascending
faster than 50px/s, velocity is cut to 40% of its current value, once. This
means the actual jump height is player-input-dependent, not a fixed number —
see the range in the next section.

---

## 3. Derived, level-design numbers

All values below come from a frame-by-frame simulation of the exact
`handlePlayerMovement()` formulas (see [Methodology](#methodology)), not a
continuous-physics approximation — that matters because the horizontal
formula is not literal acceleration (§2).

### Jump height (vertical) — depends on how long the jump key is held

| Hold behavior | Airtime | Height |
|---|---|---|
| Tap and release instantly (1 frame) | 0.33s | **~1.4 tiles** (~22px) |
| Release after 5 frames | 0.45s | ~3.0 tiles (~48px) |
| Release after 15 frames | 0.63s | ~5.5 tiles (~89px) |
| Held through the full jump | **0.72s** | **~6.0 tiles** (~96px) |

The full-hold max (~6.0 tiles) closely matches the number already hardcoded
into the LLM's system prompt in `chatBox.ts` ("can jump approximately 6 tiles
high") — that particular figure checks out against the real physics, even
though nothing in the codebase currently derives it from these constants.
The minimum (~1.4 tiles, a "tap jump") does not appear anywhere in either
system prompt today.

**Level design implication:** a step-up as short as ~1 tile is reachable even
with the smallest possible tap-jump; the ~6-tile figure is only achievable
if the player commits to holding jump for the full ~0.72s ascent. A level
that requires exactly a 6-tile clearance leaves no margin for a slightly
early release.

### Horizontal gap distance — depends heavily on run-up, *not* a single number

Because `ACCELERATION` is exponential-smoothing rather than literal
acceleration (§2), how far the player travels during a jump depends heavily
on how much flat ground they had to build up speed *before* leaving the
edge — not just on `PLAYER_SPEED` and airtime.

| Run-up before jumping | Speed at takeoff | Horizontal distance covered during the jump |
|---|---|---|
| 0 (standing jump) | 0px/s | **~6.1 tiles** |
| 0.17s (~10 frames) | 90px/s (22%) | ~8.7 tiles |
| 0.50s (~30 frames) | 213px/s (53%) | ~12.4 tiles |
| 1.00s (~60 frames) | 312px/s (78%) | ~15.3 tiles |
| 2.00s (~120 frames) | 381px/s (95%) | ~17.4 tiles |
| ≥3.3s / ~34+ tiles of runway | 400px/s (100%) | **~17.9 tiles** |

**This is the most important number for level design work:** the "same"
jump can clear anywhere from **~6 to ~18 tiles**, a 3x range, purely as a
function of runway length. A naive reachability calculation that assumes
`PLAYER_SPEED × airtime ≈ 18 tiles` for every jump will badly overestimate
what's actually crossable from a short approach (e.g. right after landing,
or in a tight room) — those situations top out around 6 tiles. Any
automated "is this gap crossable" check needs to know the available run-up
distance, not just the gap width.

### Ground stopping distance
From max speed, plain ground friction (no input) stops the player in
**0.33s, covering ~4.1 tiles (~63px)**. Relevant for judging whether the
player can stop before a hazard/ledge after landing from a jump, or whether
they'll be carried into it.

---

## 4. Known inconsistencies found while researching this

Out of scope for this doc's main ask, but directly relevant to "how to use
these units" — flagging so nothing gets assumed silently:

- **`editorScene.ts:1261-1265`** hardcodes the exact same five literals a
  second time, independently of `gameScene.ts`. They match today, but
  there's no shared source — if the real game's constants are ever tuned,
  the in-editor playtest mode will silently drift out of sync unless updated
  by hand in both places.
- **`TerrainAwareness.ts:462`** (enemy AI jump-arc reachability math) defaults
  its `gravity` parameter to `800`, not the world's actual `1500`
  (`gameScene.ts:141`). Enemy "can I reach this platform" calculations are
  currently derived against the wrong gravity.
- **System prompt disagreement on player size:** the *active* prompt
  (`chatBox.ts`) tells the LLM the player is "1 tile wide and 1 tile tall";
  a second, currently-unused prompt (`modelConnector.ts`, explicitly marked
  `// UNUSED`) says "2 tiles wide and 2 tiles tall." The actual physics body
  is set via `player.setSize(10, 14).setOffset(3, 1)` (`editorScene.ts:1020`)
  in raw texture-frame px, before the sprite's 2x display scale is applied —
  whether Arcade Physics scales that body size at runtime wasn't verified
  here (needs a runtime check, e.g. logging `player.body.width/height`
  in-game) rather than an assumption. Neither "1 tile" nor "2 tiles" should
  be trusted as-is until that's confirmed.

---

## Methodology

Numbers were produced by re-implementing the exact formulas from
`handlePlayerMovement()` (`gameScene.ts:297-392`) in an isolated script and
stepping them frame-by-frame at 60fps/16px-tiles — not solved via continuous
projectile-motion formulas, specifically because the horizontal movement
model is not literal acceleration (§2) and a closed-form approximation would
have been misleading. Vertical motion (gravity) was validated against the
continuous kinematic formula (`h = v₀²/(2g)`) and matched within rounding,
consistent with Arcade Physics integrating gravity against real delta time.
No game code was modified to produce this document.
