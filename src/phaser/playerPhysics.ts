/**
 * Player movement physics — pure math, no Phaser dependency.
 *
 * All tuning constants are expressed in TILES and SECONDS; `TILE` is the
 * single tiles→pixels conversion, applied once in the `*_PX` derivations
 * below. Tune the tile-unit values, never the px ones.
 *
 * The step functions here are pure so they can be simulated frame-by-frame
 * in tests (see __tests__/playerPhysics.test.ts, which locks in the derived
 * level-design numbers: jump height, standing-jump gap, stop distance, and
 * frame-rate independence). The Phaser-facing wrapper is playerController.ts.
 */

/** World pixels per tile. The only tiles→px conversion factor. */
export const TILE = 16;

export const PLAYER_PHYSICS = {
  // ── Horizontal (tiles/s, tiles/s²) ──────────────────────────────────────
  /**
   * Top run speed. 16 t/s = 256 px/s. Together with the fixed ~0.73s jump
   * airtime this caps the longest crossable gap at ~11.7 tiles — tuned down
   * from 25 t/s (~18-tile gaps) so the crossable-gap range stays narrow
   * enough for the AI level designer to reason about (~5.4–11.7 tiles, ~2:1).
   */
  MAX_RUN_SPEED: 16,
  /**
   * Linear ground acceleration. 0→max in ~0.8s over ~6.4 tiles of runway —
   * deliberately not instant, so max-length jumps require a real run-up
   * that level geometry can grant or deny.
   */
  GROUND_ACCEL: 20,
  /** Linear ground deceleration when no input. Max→0 in ~0.21s over ~1.7 tiles. */
  GROUND_FRICTION: 75,
  /**
   * Linear air acceleration. Equal to GROUND_ACCEL so control feels the
   * same airborne as grounded. Puts a standing jump at ~5.4 tiles.
   */
  AIR_ACCEL: 20,
  /** Linear air deceleration when no input (gentler than ground friction). */
  AIR_FRICTION: 15,

  // ── Vertical (tiles, tiles/s, tiles/s²) ─────────────────────────────────
  /** World gravity. 93.75 t/s² = 1500 px/s². */
  GRAVITY: 93.75,
  /** Full-hold jump apex, in tiles. Jump velocity is DERIVED from this. */
  JUMP_HEIGHT: 6.3,
  /** Max fall speed. 50 t/s = 800 px/s. */
  TERMINAL_VELOCITY: 50,

  // ── Jump modifiers ──────────────────────────────────────────────────────
  /** Releasing jump while rising multiplies upward speed by this, once. */
  JUMP_CUT_MULTIPLIER: 0.4,
  /** No jump-cut once rising slower than this (tiles/s; 3.125 t/s = 50 px/s). */
  JUMP_CUT_MIN_SPEED: 3.125,
  /** Seconds after leaving a ledge during which a jump still fires. */
  COYOTE_TIME: 0.06,
  /** Seconds before landing during which an early jump press is queued. */
  JUMP_BUFFER: 0.1,
} as const;

// ── Derived px-space values (never hand-edit; tune the tile units above) ──
export const MAX_RUN_SPEED_PX = PLAYER_PHYSICS.MAX_RUN_SPEED * TILE; // 256
export const GROUND_ACCEL_PX = PLAYER_PHYSICS.GROUND_ACCEL * TILE; // 320
export const GROUND_FRICTION_PX = PLAYER_PHYSICS.GROUND_FRICTION * TILE; // 1200
export const AIR_ACCEL_PX = PLAYER_PHYSICS.AIR_ACCEL * TILE; // 320
export const AIR_FRICTION_PX = PLAYER_PHYSICS.AIR_FRICTION * TILE; // 240
export const GRAVITY_PX = PLAYER_PHYSICS.GRAVITY * TILE; // 1500
export const TERMINAL_VELOCITY_PX = PLAYER_PHYSICS.TERMINAL_VELOCITY * TILE; // 800
export const JUMP_CUT_MIN_SPEED_PX = PLAYER_PHYSICS.JUMP_CUT_MIN_SPEED * TILE; // 50

/**
 * Upward impulse applied on jump, derived from the designed apex height:
 * v₀ = -√(2·g·h) ≈ -550 px/s. Negative because Phaser's Y axis points down.
 */
export const JUMP_VELOCITY_PX = -Math.sqrt(
  2 * GRAVITY_PX * PLAYER_PHYSICS.JUMP_HEIGHT * TILE,
);

/**
 * Largest timestep a single update may integrate. Caps the damage from a
 * tab-switch / GC spike so the player can't tunnel through tiles.
 */
export const MAX_STEP_DT = 1 / 30;

/** Physics body size in texture px (applied via configurePlayerSprite). */
export const PLAYER_BODY_PX = { width: 10, height: 14 } as const;

// ── Derived movement capabilities ────────────────────────────────────────
// Deliberately absent. The design-facing numbers (jump gaps, climbs, the
// crossability ladder) used to be derived here from closed-form kinematics,
// which under-reported the real maximum by 1.3-2.0 tiles because it had no
// notion of coyote time, body width, or frame quantisation.
//
// They now live in movementCapabilities.ts, computed by the frame-accurate
// search in jumpSolver.ts. That module imports this one, so the derivation
// cannot live here without a cycle -- and keeping it out means the running
// game never loads solver code just to read a gravity constant.

export interface PlayerInput {
  /** -1 left, 0 none, 1 right. Digital; left wins if both held. */
  moveInput: -1 | 0 | 1;
  jumpHeld: boolean;
  /** True only on the frame the jump key transitions up→down. */
  jumpJustPressed: boolean;
}

/** Timers/latches that persist between frames. */
export interface PlayerMovementState {
  coyoteTimer: number;
  jumpBufferTimer: number;
  /** Jump is active and has not yet been cut (or released). */
  canCutJump: boolean;
}

export function createMovementState(): PlayerMovementState {
  return { coyoteTimer: 0, jumpBufferTimer: 0, canCutJump: false };
}

/** Move `value` toward `target` by at most `maxDelta`, without overshooting. */
export function moveTowards(
  value: number,
  target: number,
  maxDelta: number,
): number {
  const delta = target - value;
  if (Math.abs(delta) <= maxDelta) return target;
  return value + Math.sign(delta) * maxDelta;
}

export interface StepResult {
  velocityX: number;
  velocityY: number;
  /** True on the frame a jump impulse was applied (for VFX/SFX hooks). */
  jumped: boolean;
}

/**
 * Advance one frame of player movement. Mutates `state` (timers/latches);
 * returns the velocities to hand to the physics body. Gravity and terminal
 * velocity are NOT applied here — Phaser Arcade integrates those itself,
 * frame-rate independently, after this runs.
 */
export function stepMovement(
  state: PlayerMovementState,
  input: PlayerInput,
  velocityX: number,
  velocityY: number,
  onGround: boolean,
  dt: number,
): StepResult {
  // Refresh jump timers BEFORE the jump check and decay them AFTER (bottom
  // of this function), so "timer > 0" means time remaining at the start of
  // this frame — otherwise the usable window is one frame shorter than the
  // constant claims.
  if (onGround) state.coyoteTimer = PLAYER_PHYSICS.COYOTE_TIME;
  if (input.jumpJustPressed) state.jumpBufferTimer = PLAYER_PHYSICS.JUMP_BUFFER;

  let newVelocityY = velocityY;
  let jumped = false;

  if (state.jumpBufferTimer > 0 && state.coyoteTimer > 0) {
    newVelocityY = JUMP_VELOCITY_PX;
    jumped = true;
    state.coyoteTimer = 0; // consume: no second jump from the same grace
    state.jumpBufferTimer = 0;
    state.canCutJump = true;
  } else if (
    !input.jumpHeld &&
    state.canCutJump &&
    newVelocityY < -JUMP_CUT_MIN_SPEED_PX
  ) {
    newVelocityY *= PLAYER_PHYSICS.JUMP_CUT_MULTIPLIER;
  }

  // Once the key is up the active jump can never be cut again.
  if (!input.jumpHeld && !jumped) {
    state.canCutJump = false;
  }

  // Decay timers for the next frame.
  if (!onGround) state.coyoteTimer = Math.max(0, state.coyoteTimer - dt);
  state.jumpBufferTimer = Math.max(0, state.jumpBufferTimer - dt);

  // Horizontal: one moveTowards covers accelerating, turning, and stopping.
  // The jump frame counts as airborne — otherwise takeoff would get one
  // frame of ground-strength acceleration, whose size depends on dt.
  const airborne = !onGround || jumped;
  const targetVelocity = input.moveInput * MAX_RUN_SPEED_PX;

  let newVelocityX;

  const changingDirection =
    input.moveInput !== 0 &&
    velocityX !== 0 &&
    Math.sign(input.moveInput) !== Math.sign(velocityX);

  if (changingDirection) {
    const turnRate = onGround ? GROUND_ACCEL_PX * 3 : AIR_ACCEL_PX * 2;

    newVelocityX = moveTowards(velocityX, targetVelocity, turnRate * dt);
  } else {
    const rate =
      input.moveInput !== 0
        ? airborne
          ? AIR_ACCEL_PX
          : GROUND_ACCEL_PX
        : airborne
          ? AIR_FRICTION_PX
          : GROUND_FRICTION_PX;
    newVelocityX = moveTowards(velocityX, targetVelocity, rate * dt);
  }

  return { velocityX: newVelocityX, velocityY: newVelocityY, jumped };
}
