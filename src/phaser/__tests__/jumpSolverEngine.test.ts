/**
 * P2: validate the pure solver against Phaser's REAL collision code.
 *
 * Every other jumpSolver test proves the solver is self-consistent. None of
 * them can catch the one modelling risk that matters: when a body crosses a
 * tile's surface with only a hair of horizontal overlap, Arcade separates on
 * the axis of *least penetration* — which can eject the body sideways into
 * the pit instead of seating it on top. That decision lives in Phaser's
 * `SeparateTile`, and it is exactly where the ULTRA tier sits.
 *
 * So this file imports `SeparateTile` and its whole chain straight out of
 * the Phaser package and drives it with a faithful stand-in for an Arcade
 * Body. No DOM required: those modules are plain CommonJS and, unlike
 * `phaser` itself, pull in no device detection.
 */
import { describe, expect, it } from "vitest";
import SeparateTile from "phaser/src/physics/arcade/tilemap/SeparateTile.js";
import { findOptimalInput, solveJump, SOLVER_FRAME_RATES } from "../jumpSolver";
import {
  createMovementState,
  GRAVITY_PX,
  PLAYER_BODY_PX,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  TILE,
} from "../playerPhysics";

/** Phaser's `World.TILE_BIAS` default. */
const TILE_BIAS = 16;

/** Minimal stand-in exposing every field SeparateTile's chain touches. */
class FakeBody {
  position: { x: number; y: number };
  prev: { x: number; y: number };
  width = PLAYER_BODY_PX.width;
  height = PLAYER_BODY_PX.height;
  velocity = { x: 0, y: 0 };
  bounce = { x: 0, y: 0 };
  blocked = { none: true, up: false, down: false, left: false, right: false };
  checkCollision = {
    none: false,
    up: true,
    down: true,
    left: true,
    right: true,
  };
  customSeparateX = false;
  customSeparateY = false;
  overlapX = 0;
  overlapY = 0;

  constructor(x: number, y: number) {
    this.position = { x, y };
    this.prev = { x, y };
  }

  get x() {
    return this.position.x;
  }
  get y() {
    return this.position.y;
  }
  get right() {
    return this.position.x + this.width;
  }
  get bottom() {
    return this.position.y + this.height;
  }

  deltaX() {
    return this.position.x - this.prev.x;
  }
  deltaY() {
    return this.position.y - this.prev.y;
  }
  deltaAbsX() {
    return Math.abs(this.deltaX());
  }
  deltaAbsY() {
    return Math.abs(this.deltaY());
  }
  updateCenter() {
    /* no-op: nothing in the separation chain reads the center */
  }
}

interface FakeTile {
  col: number;
  row: number;
  faceLeft: boolean;
  faceRight: boolean;
  faceTop: boolean;
  faceBottom: boolean;
  collideLeft: boolean;
  collideRight: boolean;
  collideUp: boolean;
  collideDown: boolean;
}

/**
 * Build the two platforms as real tiles with correctly derived collision
 * faces — a face is exposed only where the neighbouring cell is empty,
 * which is what a TilemapLayer computes via `calculateFacesWithin`.
 */
function buildWorld(
  runwayTiles: number,
  gapTiles: number,
  deltaYTiles: number,
): FakeTile[] {
  const solid = new Set<string>();
  const DEPTH = 4;
  // Takeoff platform: right edge at x = 0, top surface at y = 0.
  const firstCol = -(runwayTiles + 4);
  for (let c = firstCol; c <= -1; c++) {
    for (let r = 0; r < DEPTH; r++) solid.add(`${c},${r}`);
  }
  // Target platform: left edge at x = gapTiles * TILE, top at -deltaY.
  const targetRow = -deltaYTiles;
  for (let c = gapTiles; c <= gapTiles + 12; c++) {
    for (let r = targetRow; r < targetRow + DEPTH; r++) solid.add(`${c},${r}`);
  }

  const tiles: FakeTile[] = [];
  for (const key of solid) {
    const [c, r] = key.split(",").map(Number);
    tiles.push({
      col: c,
      row: r,
      faceLeft: !solid.has(`${c - 1},${r}`),
      faceRight: !solid.has(`${c + 1},${r}`),
      faceTop: !solid.has(`${c},${r - 1}`),
      faceBottom: !solid.has(`${c},${r + 1}`),
      collideLeft: true,
      collideRight: true,
      collideUp: true,
      collideDown: true,
    });
  }
  return tiles;
}

function tileRect(t: FakeTile) {
  return {
    left: t.col * TILE,
    top: t.row * TILE,
    right: (t.col + 1) * TILE,
    bottom: (t.row + 1) * TILE,
  };
}

interface EngineResult {
  landed: boolean;
  landedOnTarget: boolean;
}

/**
 * Replay an input sequence through Phaser's real tile separation.
 * Mirrors PlayerController.update() → Arcade world step → collide.
 */
function runEngine(
  dt: number,
  runwayTiles: number,
  phasePx: number,
  jumpFrame: number,
  holdFrames: number,
  gapTiles: number,
  deltaYTiles: number,
): EngineResult {
  const tiles = buildWorld(runwayTiles, gapTiles, deltaYTiles);
  const W = PLAYER_BODY_PX.width;
  const H = PLAYER_BODY_PX.height;

  const startLeft = -(runwayTiles * TILE + W) + phasePx;
  const body = new FakeBody(startLeft, -H); // bottom exactly on y = 0
  const state = createMovementState();
  let prevJump = false;
  let onGround = true;
  const targetTop = -deltaYTiles * TILE;
  const targetLeft = gapTiles * TILE;

  for (let f = 0; f < 1400; f++) {
    const held = f >= jumpFrame && f < jumpFrame + holdFrames;
    const jjp = held && !prevJump;
    prevJump = held;

    const r = stepMovement(
      state,
      { moveInput: 1, jumpHeld: held, jumpJustPressed: jjp },
      body.velocity.x,
      body.velocity.y,
      onGround,
      dt,
    );
    body.velocity.x = r.velocityX;
    body.velocity.y = r.velocityY;

    // Arcade world step.
    body.velocity.y = Math.min(
      body.velocity.y + GRAVITY_PX * dt,
      TERMINAL_VELOCITY_PX,
    );
    body.prev = { x: body.position.x, y: body.position.y };
    body.position.x += body.velocity.x * dt;
    body.position.y += body.velocity.y * dt;

    // Collision pass, exactly as the real engine resolves it.
    body.blocked = {
      none: true,
      up: false,
      down: false,
      left: false,
      right: false,
    };
    for (let i = 0; i < tiles.length; i++) {
      const rect = tileRect(tiles[i]);
      const intersects = !(
        body.right <= rect.left ||
        body.bottom <= rect.top ||
        body.position.x >= rect.right ||
        body.position.y >= rect.bottom
      );
      if (!intersects) continue;
      SeparateTile(i, body, tiles[i], rect, null, TILE_BIAS, true);
    }

    onGround = body.blocked.down;

    if (onGround && body.bottom <= targetTop + 0.5 && body.right > targetLeft) {
      return { landed: true, landedOnTarget: true };
    }
    if (body.position.y > targetTop + 300 * TILE) {
      return { landed: false, landedOnTarget: false };
    }
  }
  return { landed: onGround, landedOnTarget: false };
}

describe("solver claims hold up against Phaser's real tile separation", () => {
  it("sanity: the engine harness can cross an easy gap", () => {
    const best = findOptimalInput({ runwayTiles: 4, deltaYTiles: 0 }, 1 / 60)!;
    const res = runEngine(
      1 / 60,
      4,
      best.phasePx,
      best.jumpFrame,
      best.holdFrames,
      4,
      0,
    );
    expect(res.landedOnTarget).toBe(true);
  });

  it("the GUARANTEED gap lands in the real engine at every frame rate", () => {
    for (const runwayTiles of [0, 2, 4, 7]) {
      const spec = solveJump({ runwayTiles, deltaYTiles: 0 });
      const gap = Math.floor(spec.guaranteedTiles);
      for (const dt of SOLVER_FRAME_RATES) {
        const best = findOptimalInput({ runwayTiles, deltaYTiles: 0 }, dt)!;
        const res = runEngine(
          dt,
          runwayTiles,
          best.phasePx,
          best.jumpFrame,
          best.holdFrames,
          gap,
          0,
        );
        expect(
          res.landedOnTarget,
          `runway=${runwayTiles} gap=${gap} dt=${dt.toFixed(4)}`,
        ).toBe(true);
      }
    }
  });

  it("the ULTRA gap, floored to whole tiles, lands in the real engine", () => {
    // The headline claim: the widest whole-tile gap the solver says is
    // clearable really is clearable by Phaser's own collision code.
    for (const runwayTiles of [0, 2, 4, 7]) {
      const spec = solveJump({ runwayTiles, deltaYTiles: 0 });
      const gap = Math.floor(spec.ultraTiles);
      let anyRateLanded = false;
      for (const dt of SOLVER_FRAME_RATES) {
        const best = findOptimalInput({ runwayTiles, deltaYTiles: 0 }, dt)!;
        const res = runEngine(
          dt,
          runwayTiles,
          best.phasePx,
          best.jumpFrame,
          best.holdFrames,
          gap,
          0,
        );
        if (res.landedOnTarget) anyRateLanded = true;
      }
      expect(anyRateLanded, `runway=${runwayTiles} gap=${gap}`).toBe(true);
    }
  });

  it("impossibleTiles really is impossible in the real engine", () => {
    for (const runwayTiles of [0, 2, 4, 7]) {
      const spec = solveJump({ runwayTiles, deltaYTiles: 0 });
      for (const dt of SOLVER_FRAME_RATES) {
        const best = findOptimalInput({ runwayTiles, deltaYTiles: 0 }, dt)!;
        const res = runEngine(
          dt,
          runwayTiles,
          best.phasePx,
          best.jumpFrame,
          best.holdFrames,
          spec.impossibleTiles,
          0,
        );
        expect(
          res.landedOnTarget,
          `runway=${runwayTiles} gap=${spec.impossibleTiles} dt=${dt.toFixed(4)}`,
        ).toBe(false);
      }
    }
  });

  it("drops to a lower platform also hold up", () => {
    for (const deltaYTiles of [-2, -5]) {
      const spec = solveJump({ runwayTiles: 4, deltaYTiles });
      const gap = Math.floor(spec.guaranteedTiles);
      const best = findOptimalInput({ runwayTiles: 4, deltaYTiles }, 1 / 60)!;
      const res = runEngine(
        1 / 60,
        4,
        best.phasePx,
        best.jumpFrame,
        best.holdFrames,
        gap,
        deltaYTiles,
      );
      expect(res.landedOnTarget, `deltaY=${deltaYTiles} gap=${gap}`).toBe(true);
    }
  });
});
