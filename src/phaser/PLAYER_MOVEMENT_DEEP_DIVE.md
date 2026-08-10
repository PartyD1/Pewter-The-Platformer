# Player Movement — Full Deep Dive

> **⚠️ HISTORICAL (2026-08-10):** This doc describes the OLD movement system,
> which has been replaced. The frame-rate dependence, exponential
> acceleration, duplicated editor copy, and flip/hitbox inconsistencies
> documented below are all fixed — movement now lives in `playerPhysics.ts` +
> `playerController.ts`, verified by `__tests__/playerPhysics.test.ts`. See
> `PLAYER_MOVEMENT_REWORK_PLAN.md`. Kept for reference.

Everything the player controller does, end to end: input → horizontal
movement → jumping → collision/landing → edge cases → visual effects. Every
section has a **Technical** explanation (code, formulas, line numbers) and a
**Plain English** explanation (no jargon). This file is written to be read
on its own — you shouldn't need any other doc or prior conversation to
follow it.

Source: `src/phaser/gameScene.ts` (the file actually used during real
gameplay). `src/phaser/editorScene.ts:1202-1315` implements an independent,
line-for-line copy of the same logic for in-editor playtesting — everything
below applies equally to both, see [§10](#10-known-inconsistencies) for the
risk that creates.

**No code was changed to write this document.**

---

## TL;DR

- The player accelerates, decelerates, and turns using a **custom,
  hand-written formula that only runs correctly at 60 frames per second** —
  it does not adapt to the player's actual machine speed. Run on a slower or
  faster machine, and the *feel* of running/stopping changes.
- Jumping, falling, and gravity are handled by Phaser's built-in physics
  engine, which **does** correctly adapt to real elapsed time — jump height
  and airtime are consistent regardless of frame rate.
- Horizontal top speed is a hard clamp (400 px/s); how fast you get there is
  not a simple ramp — it's an exponential "ease" that takes far longer to
  finish than the constant's name suggests (~2 real seconds to reach 95% of
  top speed from a standstill).
- Jump height is variable (~1.4 to ~6.0 tiles) depending on how long the
  jump button is held.
- The dust-particle visual effects for walking/jumping exist in code but are
  currently **dead** — never initialized, so they silently no-op every time.

---

## 1. The big picture: what runs every frame

**Technical:** Phaser calls `GameScene.update()` once per rendered frame
(`gameScene.ts:283-292`). That function does exactly one movement-relevant
thing: calls `handlePlayerMovement()` (`gameScene.ts:297-392`). That single
method is the entire player controller — it reads input, computes the next
horizontal and vertical velocity, applies it, checks landing/falling state,
and checks whether the player fell off the map. There is no separate "physics
step" function or fixed-timestep loop; it all happens inline, once per
rendered frame, using whatever velocity numbers were true at the *start* of
that frame.

**Plain English:** Every single frame drawn on screen, the game asks "what
keys are held right now?", nudges the player's speed toward whatever that
implies, applies gravity, and moves the player. There's one function that
does the player's entire brain for movement — nothing more, nothing less.

---

## 2. Coordinate system & world units

**Technical:**
- Tiles are 16×16 world pixels (`addTilesetImage(..., 16, 16, ...)`,
  `gameScene.ts:86-93`). All velocity/position numbers in the code are in
  these world pixels; divide by 16 to convert to tiles.
- X increases rightward, **Y increases downward** (standard screen/Phaser
  convention). This is why jump velocity is *negative* — moving up means
  decreasing Y.
- The camera's zoom (`setZoom(2.25)`, `gameScene.ts:182`) and the player
  sprite's render scale (`setScale(2)`, `gameScene.ts:164`) are purely
  visual. They change how big things look on screen; they do **not** change
  any of the physics numbers discussed in this document.

**Plain English:** Think of the game world as a grid of 16-pixel tiles, with
"up" on screen corresponding to smaller numbers. Zooming the camera in or
making the character sprite bigger is just cosmetic — under the hood, the
game still measures everything in the same tile-based ruler.

---

## 3. Reading input

**Technical (`gameScene.ts:307-313`):**
```ts
if (this.cursors.left.isDown || this.wasd.A.isDown) {
  moveInput = -1;
  player.setFlipX(false);
} else if (this.cursors.right.isDown || this.wasd.D.isDown) {
  moveInput = 1;
  player.setFlipX(true);
}
```
Both arrow keys and WASD work. `moveInput` is a simple direction flag
(-1, 0, or 1) — there's no analog input, so there's no "half speed" from a
gamepad stick or similar; it's fully digital. `setFlipX` mirrors the sprite
so the character visually faces the direction it's moving. If left is held,
`moveInput` wins even if right is also held (the `else if` means left is
checked first and takes priority).

**Plain English:** Press left/A or right/D (or the arrow keys) to pick a
direction. The character sprite flips to face that way. If you awkwardly hold
both directions at once, left wins.

---

## 4. Horizontal movement: acceleration & friction

This is the part that answers "is it tied to FPS?" — **yes**, in full detail
below.

### 4a. While a direction is held (`gameScene.ts:315-330`)

**Technical:**
```ts
const acceleration = onGround ? ACCELERATION : ACCELERATION * AIR_CONTROL;
const targetVelocity = moveInput * PLAYER_SPEED;

if (Math.abs(velocityX - targetVelocity) > 5) {
  velocityX += (targetVelocity - velocityX) * (acceleration / 1000) * (1/60);
  velocityX = Phaser.Math.Clamp(velocityX, -PLAYER_SPEED, PLAYER_SPEED);
} else {
  velocityX = targetVelocity;
}
```
This is **not** constant acceleration (a fixed px/s² added every frame).
It's exponential smoothing: each frame, velocity closes the *remaining gap*
to the 400px/s target by a fixed **fraction** —
`(ACCELERATION/1000) * (1/60)` = `(1500/1000) * (1/60)` ≈ **2.5% of the
remaining gap, per frame, on the ground** (80% of that, ~2%, while airborne,
because of `AIR_CONTROL = 0.8`).

That `(1/60)` is a hardcoded assumption of 60 frames per second. It is
**not** Phaser's actual per-frame `delta` — `update()` doesn't even receive
that parameter (`gameScene.ts:283`). So the "2.5% of the gap per frame" rate
is only correct if the game is actually rendering at 60fps. On a machine
running at 30fps, this code still runs once per frame and still closes 2.5%
of the gap *per frame* — but since there are only half as many frames per
second, the player closes the gap at roughly half the intended rate per
second of real time (floatier, slower to speed up/stop). On a 144fps
machine, the opposite: 2.4x more frames per second means the player reaches
top speed and stops noticeably faster than intended. **Gravity and jumping
do not have this problem** — those are handled by Phaser's physics engine
internally, which uses the real elapsed time between frames, not a hardcoded
guess.

Because it's exponential rather than linear, the practical consequence is
large: reaching 95% of top speed from a dead stop takes **~119 frames
(~2 real seconds at 60fps) and about 34 tiles of flat runway** — much slower
than the "1500" in the constant's name would suggest if read as literal
px/s² acceleration (which would predict topping out in ~0.27s). See the
[cheat sheet](#9-cheat-sheet-all-derived-numbers) for the full runway table.

**Plain English:** Holding a direction doesn't give you a steady push — it's
more like the character is on a leash that keeps pulling harder the further
it is from full speed, but the pull always weakens as you get closer to full
speed, so the last little bit takes a surprisingly long time. And because
the game measures that pull "per frame" instead of "per second," if the game
runs choppier or smoother than 60 frames per second on someone's computer,
their character will actually speed up and slow down at a different rate
than on another machine — even though every other part of the physics
(gravity, jump height) stays exactly the same for everyone.

### 4b. While no direction is held — friction (`gameScene.ts:331-356`)

**Technical:**
```ts
// On ground:
const frictionForce = FRICTION * (1/60);           // = 20 px/s per frame
velocityX -= Math.sign(velocityX) * frictionForce;  // (or snap to 0 if smaller)

// In air:
const airFriction = FRICTION * 0.3 * (1/60);        // = 6 px/s per frame
velocityX -= Math.sign(velocityX) * airFriction;
```
Unlike the acceleration formula above, this **is** literal, linear
deceleration: a fixed amount of speed (`FRICTION * dt`) is subtracted every
frame until velocity hits zero. It has the exact same 60fps-hardcoding issue
as §4a — on a different frame rate, stopping will be faster or slower than
intended, in real-time terms. In-air friction uses an unrelated, unnamed
`0.3` multiplier hardcoded directly in the branch (not tied to
`AIR_CONTROL`, which only affects §4a's acceleration-toward-target, not
this deceleration-toward-zero).

From max speed (400px/s), ground friction stops the player in **0.33s,
covering ~63px (~4 tiles)**. Air friction is weaker (1.11s to fully stop),
but a jump only lasts ~0.72s, so in practice you never fully lose your air
momentum to friction alone during a single jump.

**Plain English:** Letting go of the direction key isn't an instant stop —
the character skids to a halt, faster on the ground than in midair. Ground
skidding covers about 4 tile-widths from full speed. Skidding to a stop in
midair is much weaker and gentler, which is why you keep drifting during a
jump if you let go of the direction key partway through.

---

## 5. Vertical movement: gravity, jumping, and jump-cut

**Technical — gravity:** `physics.world.gravity.y = 1500` is set once at
scene creation (`gameScene.ts:141`) and applied automatically, every frame,
by Phaser's Arcade Physics engine to every physics body in the scene
(including the player). Unlike the horizontal code above, this integration
uses the real elapsed frame time internally, so it is **frame-rate
independent** — gravity's effect over one real-world second is the same
regardless of how many frames that second took to render.

**Technical — starting a jump (`gameScene.ts:357-365`):**
```ts
const jumpPressed = this.cursors.up.isDown || this.wasd.W.isDown;
if (jumpPressed && !this.isJumpPressed && onGround) {
  velocityY = this.JUMP_VELOCITY; // -550 px/s, instantly
  this.isJumpPressed = true;
  player.isFalling = false;
  this.startJumpVFX();
}
```
A jump only starts on the exact frame the jump key transitions from
*not held* to *held* (`!this.isJumpPressed` guards against holding the key
down triggering it every frame), and only if `onGround` is true
(`body.blocked.down`, i.e. the physics engine detected the player resting on
a solid tile last frame). The jump itself is a single instantaneous velocity
assignment — an "impulse," not a force applied over time — of -550px/s
(negative = upward, per §2). From that point on, gravity alone shapes the
rest of the arc; nothing in the code actively pushes the player upward after
this one frame.

**Technical — jump-cut / variable height (`gameScene.ts:366-374`):**
```ts
} else if (!jumpPressed && this.isJumpPressed && velocityY < -50) {
  velocityY *= 0.4; // cut the upward velocity short
}
if (!jumpPressed) {
  this.isJumpPressed = false;
}
```
If the jump key is released while the player is still moving upward faster
than 50px/s, the current upward velocity is immediately multiplied by 0.4
(cut to 40% of whatever it currently was) — once. This is what makes jump
height variable: a quick tap produces a short hop (~1.4 tiles), holding the
whole way up produces the full ~6.0-tile jump, and anything in between
produces a proportional result. If the player is already past the point of
moving upward faster than 50px/s (i.e. near or past the apex) when they
release, no cut happens — they get the full remaining arc.

**Plain English:** Jumping isn't something the game keeps pushing you up
through — you get one instant "shove" upward the moment you press jump
(only usable while standing on solid ground), and after that, gravity pulls
you back down exactly like anything falling in real life. But there's a
trick: if you let go of the jump button early, *while still rising*, your
upward speed gets chopped down right then, which is what lets you do a
short hop instead of a full jump. Wait long enough before releasing (or hold
it the whole time) and you get the full ~6-tile jump; tap it instantly and
you barely get off the ground (~1.4 tiles).

---

## 6. Collision, landing, and state tracking

**Technical:** `this.physics.add.collider(this.player, this.groundLayer)`
(`gameScene.ts:191`) is set up once, and every subsequent frame Phaser's
physics engine resolves overlaps between the player and any solid ground
tile automatically — this is what actually stops the player from falling
through the floor or walking through walls, and it's what sets
`body.blocked.down` to `true` when the player is resting on something,
which is what `onGround` reads at the top of `handlePlayerMovement()`
(`gameScene.ts:300`). None of the movement code above directly checks tile
positions; it entirely trusts Phaser's collider resolution for "am I
touching the ground."

There's also an `isFalling` flag (`gameScene.ts:380-384`) that gets set to
`true` when airborne and moving downward, and cleared when landing. As of
this file's writing, nothing outside this same method reads it — it's not
currently driving any animation, sound, or fall-damage logic. It exists but
is presently inert beyond its own bookkeeping.

**Plain English:** The game doesn't do any special "is there ground below
me" math in the movement code — it relies entirely on Phaser's built-in
collision system to say "yes, you're standing on something" or "no, you're
in the air," and the jump/gravity logic just reacts to that flag. There's
also a separate "am I currently falling" flag being tracked, but right now
nothing actually uses it for anything visible — it's set up but not wired
to anything yet.

---

## 7. Falling off the map (`gameScene.ts:386-391`)

**Technical:**
```ts
if (player.y > this.map.heightInPixels + 100) {
  player.setPosition(100, 150);
  player.setVelocity(0, 0);
}
```
Checked every frame: if the player's Y position drops more than 100px below
the bottom of the map, they're teleported back to the fixed spawn point
(100, 150) with velocity reset to zero. There's no health penalty, death
animation, or life lost tied to this in `gameScene.ts` — it's a pure
position safety net. (Note: `editorScene.ts`'s separate playtest
implementation does tie falling off the map into its health/death system —
see `editorScene.ts:1232-1238` — so behavior differs slightly between real
gameplay and in-editor playtesting.)

**Plain English:** Fall into a pit with no bottom, and rather than falling
forever, the game just quietly teleports you back to the start after you've
dropped far enough below the level. In the main game this doesn't cost you
anything by itself; the in-editor playtest mode is stricter and treats it
as a hit against your health.

---

## 8. Visual effects (currently dead code)

**Technical:** `startWalkingVFX()` and `startJumpVFX()`
(`gameScene.ts:399-424`) are called at the right moments (walking on the
ground, starting a jump) and would trigger dust particle emitters — but the
particle emitter setup that would populate `this.vfx.walking` and
`this.vfx.jump` is entirely commented out in `create()`
(`gameScene.ts:210-230`). Both VFX functions open with `if (!this.vfx.X)
return;`, and since neither is ever assigned, both functions silently return
immediately, every time, forever. The code paths that call them are live and
correctly triggered — the payload they'd trigger simply isn't wired up.

**Plain English:** The game is set up to kick up dust particles when you
walk or jump, and it correctly knows *when* to do that — but the actual
particle effect was disabled (commented out) elsewhere, so right now nothing
visibly happens. It's a feature that's half-built and silently doing
nothing, not a bug that produces an error.

---

## 9. Cheat sheet: all derived numbers

Frame-accurate simulation of the exact formulas above (60fps, 16px tiles) —
not textbook physics approximations, since §4a specifically isn't literal
acceleration.

**Jump height (depends on how long jump is held):**

| Hold | Airtime | Height |
|---|---|---|
| Instant tap | 0.33s | ~1.4 tiles (~22px) |
| Release @ 5 frames | 0.45s | ~3.0 tiles (~48px) |
| Release @ 15 frames | 0.63s | ~5.5 tiles (~89px) |
| Full hold | 0.72s | ~6.0 tiles (~96px) |

**Horizontal gap distance during a jump (depends on run-up before takeoff):**

| Run-up before jumping | Speed at takeoff | Distance covered |
|---|---|---|
| None (standing jump) | 0px/s | ~6.1 tiles |
| 0.17s | 90px/s (22%) | ~8.7 tiles |
| 0.50s | 213px/s (53%) | ~12.4 tiles |
| 1.00s | 312px/s (78%) | ~15.3 tiles |
| 2.00s | 381px/s (95%) | ~17.4 tiles |
| ~3.3s+ / 34+ tiles runway | 400px/s (100%) | ~17.9 tiles |

**Other:**
- Ground stopping distance from top speed: ~4.1 tiles (0.33s)
- Runway needed to reach ~95% top speed: ~34 tiles (~2.0s)
- Runway needed to reach 100% top speed (clean snap): ~50 tiles (~3.3s)

---

## 10. Known inconsistencies

Flagged because they affect how much to trust the numbers above in other
contexts — not the focus of this doc, kept brief:

- `editorScene.ts:1261-1265` hardcodes the same five constants a second,
  independent time for in-editor playtesting. They match today but aren't
  shared code — if the real game's values ever change, the editor's
  playtest feel can silently drift out of sync.
- The enemy AI's jump-reachability math (`TerrainAwareness.ts:462`) assumes
  gravity of `800`, not the world's real `1500` — enemy "can I reach that
  platform" logic is calculated against the wrong gravity.
- The LLM's active system prompt (`chatBox.ts`) says the player is "1 tile
  wide and 1 tile tall"; an unused prompt (`modelConnector.ts`) says
  "2 tiles wide and 2 tiles tall." The real physics body
  (`editorScene.ts:1020`, `setSize(10, 14)`) doesn't cleanly confirm either
  claim — unverified, would need a runtime check.

See `src/phaser/PLAYER_CONTROLLER_PHYSICS.md` for the original, narrower
write-up focused specifically on the five constants' units.

---

## One-paragraph summary (plain English, all of it)

Every frame, the game checks which keys you're holding. Left/right nudges
your speed toward a 400px/s cap using a "closing the gap" formula that's
measured *per frame* rather than *per second* — meaning your actual
real-world acceleration feel literally depends on how fast your computer is
rendering frames, unlike everything else in this controller. Jumping gives
you one instant upward shove the moment you press it (only from the ground),
and after that gravity — which *is* consistent across all machines — takes
over completely; how long you hold the jump button determines whether you
get a small hop or the full ~6-tile jump. How far you travel sideways during
a jump depends heavily on how much of a running start you had, ranging from
about 6 tiles (standing jump) to about 18 tiles (full sprint). Landing and
ground detection are handled entirely by the game engine's built-in
collision system, not custom code. Falling into a bottomless pit just
teleports you back to the start. And the dust-kicking visual effects that
are supposed to play while you walk and jump are currently disabled, so you
won't see them no matter what you do.

---

## Methodology

Every derived number was produced by re-implementing the exact formulas
from `handlePlayerMovement()` (`gameScene.ts:297-392`) in an isolated script
and stepping them frame-by-frame at 60fps — not solved with continuous
projectile-motion shortcuts, because §4a's horizontal formula specifically
isn't literal acceleration and a shortcut would have been misleading.
Vertical (gravity-driven) results were cross-checked against the continuous
kinematic formula `h = v₀²/(2g)` and matched within rounding, consistent
with Phaser's Arcade Physics integrating gravity against real elapsed time.
No game code was modified to produce this document.
