import { describe, expect, it } from "vitest";
import {
  findOptimalInput,
  HUMAN_HARD_TIER,
  JUMP_TIERS,
  latitudeForGap,
  maxGapAtRate,
  solveJump,
  SOLVER_FRAME_RATES,
  TIER_LATITUDE_MS,
  tierForGap,
  type JumpSituation,
} from "../jumpSolver";
import {
  createMovementState,
  GRAVITY_PX,
  PLAYER_BODY_PX,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  TILE,
} from "../playerPhysics";

const RUNWAYS = [0, 1, 2, 4, 7, 20];

describe("spectrum ordering", () => {
  it("tiers are ordered easiest→hardest for every runway", () => {
    for (const runwayTiles of RUNWAYS) {
      const s = solveJump({ runwayTiles, deltaYTiles: 0 });
      expect(s.guaranteedTiles).toBeLessThanOrEqual(s.normalTiles);
      expect(s.normalTiles).toBeLessThanOrEqual(s.expertTiles);
      expect(s.expertTiles).toBeLessThanOrEqual(s.ultraTiles);
      expect(s.impossibleTiles).toBeGreaterThan(s.ultraTiles);
    }
  });

  it("more runway never reduces reach at any tier", () => {
    let prev = solveJump({ runwayTiles: RUNWAYS[0], deltaYTiles: 0 });
    for (const runwayTiles of RUNWAYS.slice(1)) {
      const cur = solveJump({ runwayTiles, deltaYTiles: 0 });
      // Allow a hair of slack (0.05 tiles ≈ 0.8px): the sweep is discrete,
      // not analytic, and the fixed-step accumulator means a given takeoff
      // phase lands on slightly different physics-step boundaries at
      // different runway lengths.
      expect(cur.guaranteedTiles).toBeGreaterThanOrEqual(
        prev.guaranteedTiles - 0.05,
      );
      expect(cur.ultraTiles).toBeGreaterThanOrEqual(prev.ultraTiles - 0.05);
      prev = cur;
    }
  });

  it("dropping to a lower target reaches further; rising reaches less", () => {
    const level = solveJump({ runwayTiles: 4, deltaYTiles: 0 });
    const down = solveJump({ runwayTiles: 4, deltaYTiles: -6 });
    const up = solveJump({ runwayTiles: 4, deltaYTiles: 3 });
    expect(down.ultraTiles).toBeGreaterThan(level.ultraTiles);
    expect(up.ultraTiles).toBeLessThan(level.ultraTiles);
  });

  it("runway saturates — beyond top speed more run-up adds nothing", () => {
    const a = solveJump({ runwayTiles: 7, deltaYTiles: 0 });
    const b = solveJump({ runwayTiles: 20, deltaYTiles: 0 });
    expect(Math.abs(a.ultraTiles - b.ultraTiles)).toBeLessThan(0.1);
  });
});

describe("latitude semantics", () => {
  it("each tier's gap delivers at least that tier's timing slop", () => {
    for (const runwayTiles of [0, 2, 4, 7]) {
      const s = solveJump({ runwayTiles, deltaYTiles: 0 });
      for (const tier of JUMP_TIERS) {
        // Floating-point bisection lands a hair under the threshold.
        expect(s.latitudeMs[tier]).toBeGreaterThanOrEqual(
          TIER_LATITUDE_MS[tier] - 1e-6,
        );
      }
      expect(s.latitudeMs.ULTRA).toBeGreaterThan(0);
    }
  });

  it("latitude decreases monotonically as the gap widens", () => {
    const s: JumpSituation = { runwayTiles: 4, deltaYTiles: 0 };
    let prev = Infinity;
    for (let gap = 4; gap <= 13; gap += 0.5) {
      const ms = latitudeForGap(s, gap);
      expect(ms).toBeLessThanOrEqual(prev + 1e-6);
      prev = ms;
    }
  });

  it("nothing at or beyond impossibleTiles lands, at any timing", () => {
    for (const runwayTiles of RUNWAYS) {
      const s: JumpSituation = { runwayTiles, deltaYTiles: 0 };
      const spec = solveJump(s);
      expect(latitudeForGap(s, spec.impossibleTiles)).toBe(0);
      expect(tierForGap(s, spec.impossibleTiles)).toBe("IMPOSSIBLE");
      expect(latitudeForGap(s, spec.ultraTiles + 0.5)).toBe(0);
    }
  });

  it("impossibleTiles is impossible at EVERY frame rate, not just the worst", () => {
    // The requirable tiers come from the worst frame rate; the impossible
    // bound has to come from the best one. Deriving both from the worst
    // makes impossibleTiles too small, and reachability then reports dead
    // ends that a high-refresh player walks straight past.
    for (const runwayTiles of RUNWAYS) {
      const s: JumpSituation = { runwayTiles, deltaYTiles: 0 };
      const spec = solveJump(s);
      for (const dt of SOLVER_FRAME_RATES) {
        expect(
          maxGapAtRate(s, dt),
          `runway=${runwayTiles} dt=${dt.toFixed(4)}`,
        ).toBeLessThan(spec.impossibleTiles);
      }
    }
  });

  it("the best-case ceiling is never below the everywhere-safe maximum", () => {
    for (const runwayTiles of RUNWAYS) {
      const spec = solveJump({ runwayTiles, deltaYTiles: 0 });
      expect(spec.bestCaseUltraTiles).toBeGreaterThanOrEqual(spec.ultraTiles);
      expect(spec.impossibleTiles).toBeGreaterThan(spec.bestCaseUltraTiles);
    }
  });

  it("tierForGap agrees with the spectrum's own boundaries", () => {
    const s: JumpSituation = { runwayTiles: 4, deltaYTiles: 0 };
    const spec = solveJump(s);
    expect(tierForGap(s, spec.guaranteedTiles)).toBe("GUARANTEED");
    expect(tierForGap(s, spec.ultraTiles)).not.toBe("IMPOSSIBLE");
    // Just past a tier boundary you drop to the next tier down in ease.
    expect(tierForGap(s, spec.guaranteedTiles + 0.2)).not.toBe("GUARANTEED");
  });

  it("EXPERT is the designated human ceiling, strictly under ULTRA", () => {
    expect(HUMAN_HARD_TIER).toBe("EXPERT");
    expect(TIER_LATITUDE_MS.EXPERT).toBeGreaterThan(TIER_LATITUDE_MS.ULTRA);
    const s = solveJump({ runwayTiles: 4, deltaYTiles: 0 });
    expect(s.expertTiles).toBeLessThan(s.ultraTiles);
  });
});

/**
 * Frame-by-frame replay used to confirm the solver's claims independently
 * of the solver's own bookkeeping. Mirrors the live loop, same as the
 * harness in playerPhysics.test.ts.
 */
function replay(
  dt: number,
  runwayTiles: number,
  phasePx: number,
  jumpFrame: number,
  holdFrames: number,
  gapTiles: number,
  deltaYTiles: number,
): boolean {
  const W = PLAYER_BODY_PX.width;
  const state = createMovementState();
  let left = -(runwayTiles * TILE + W) + phasePx;
  let bottom = 0;
  let vx = 0;
  let vy = 0;
  let onGround = true;
  let prevJump = false;
  let offPlatform = false;
  const targetY = -deltaYTiles * TILE;
  const targetLeft = gapTiles * TILE;

  // Controller at the render rate, physics at a fixed 1/60 — the same split
  // Arcade uses (World defaults: fps 60, fixedStep true).
  const PHYSICS_DT = 1 / 60;
  let accumulator = 0;

  for (let f = 0; f < 1400; f++) {
    const held = f >= jumpFrame && f < jumpFrame + holdFrames;
    const jjp = held && !prevJump;
    prevJump = held;
    const r = stepMovement(
      state,
      { moveInput: 1, jumpHeld: held, jumpJustPressed: jjp },
      vx,
      vy,
      onGround,
      dt,
    );
    vx = r.velocityX;
    vy = r.velocityY;

    accumulator += dt;
    while (accumulator >= PHYSICS_DT - 1e-9) {
      accumulator -= PHYSICS_DT;
      vy = Math.min(vy + GRAVITY_PX * PHYSICS_DT, TERMINAL_VELOCITY_PX);
      left += vx * PHYSICS_DT;
      bottom += vy * PHYSICS_DT;
      const supported = left < 0;
      if (supported && bottom >= 0 && vy > 0) {
        bottom = 0;
        vy = 0;
        onGround = true;
      } else {
        onGround = supported && bottom === 0 && vy === 0;
      }
      if (!supported) offPlatform = true;

      if (offPlatform && bottom > targetY && left + W > targetLeft) {
        // First step where we are both below the surface and into the
        // target. Arcade seats us on top when we sank less than we
        // overlapped; otherwise it shoves us back out.
        const sink = bottom - targetY;
        const overlap = left + W - targetLeft;
        return vy > 0 && sink <= 16 && sink <= overlap;
      }
      if (offPlatform && bottom > targetY + 400 * TILE) return false;
    }
  }
  return false;
}

describe("claims survive independent replay", () => {
  it("the ULTRA gap is actually cleared by the reported optimal input", () => {
    for (const runwayTiles of [0, 2, 4, 7]) {
      for (const dt of SOLVER_FRAME_RATES) {
        const best = findOptimalInput({ runwayTiles, deltaYTiles: 0 }, dt);
        expect(best).not.toBeNull();
        const landed = replay(
          dt,
          runwayTiles,
          best!.phasePx,
          best!.jumpFrame,
          best!.holdFrames,
          best!.gapTiles,
          0,
        );
        expect(landed).toBe(true);
      }
    }
  });

  it("the GUARANTEED gap lands at every frame rate", () => {
    for (const runwayTiles of [0, 2, 4, 7]) {
      const spec = solveJump({ runwayTiles, deltaYTiles: 0 });
      for (const dt of SOLVER_FRAME_RATES) {
        const best = findOptimalInput({ runwayTiles, deltaYTiles: 0 }, dt);
        const landed = replay(
          dt,
          runwayTiles,
          best!.phasePx,
          best!.jumpFrame,
          best!.holdFrames,
          spec.guaranteedTiles,
          0,
        );
        expect(landed).toBe(true);
      }
    }
  });
});

describe("the coyote-time exploit is represented", () => {
  it("the max-distance jump is pressed AFTER leaving the ledge", () => {
    // This is the whole reason the solver exists. If it ever regresses to
    // jumping at or before the ledge frame, the search has lost the
    // technique and the numbers have silently collapsed to the old
    // closed-form answer.
    for (const runwayTiles of [2, 4, 7]) {
      const best = findOptimalInput({ runwayTiles, deltaYTiles: 0 }, 1 / 60);
      expect(best).not.toBeNull();
      expect(best!.jumpFrame).toBeGreaterThan(best!.ledgeFrame);
    }
  });

  it("beats what the same jump achieves if pressed at the ledge", () => {
    const dt = 1 / 60;
    const runwayTiles = 4;
    const best = findOptimalInput({ runwayTiles, deltaYTiles: 0 }, dt)!;
    // Same phase, but forced to jump on the ledge frame.
    let atLedge = 0;
    for (let g = 4; g < 20; g += 0.01) {
      if (!replay(dt, runwayTiles, best.phasePx, best.ledgeFrame, 1e9, g, 0)) {
        break;
      }
      atLedge = g;
    }
    expect(best.gapTiles).toBeGreaterThan(atLedge);
  });
});

describe("regression floor vs the old closed form", () => {
  /**
   * The retired `calculateMaxGap()`, inlined. The bug being fixed was that
   * it UNDER-reports; over-correcting back into under-reporting is the
   * regression this guards.
   */
  function legacyMaxGap(runwayTiles: number, deltaYDownTiles: number): number {
    const GROUND_ACCEL_PX = 320;
    const MAX_RUN = 256;
    const AIR_ACCEL_PX = 320;
    const g = 1500;
    const v0y = -Math.sqrt(2 * g * 6.3 * TILE);
    const deltaYPx = deltaYDownTiles * TILE;
    const v0x = Math.min(
      Math.sqrt(2 * GROUND_ACCEL_PX * runwayTiles * TILE),
      MAX_RUN,
    );
    const disc = v0y * v0y + 2 * g * deltaYPx;
    if (disc < 0) return 0;
    const t = (-v0y + Math.sqrt(disc)) / g;
    const tCap = (MAX_RUN - v0x) / AIR_ACCEL_PX;
    const d =
      tCap >= t
        ? v0x * t + 0.5 * AIR_ACCEL_PX * t * t
        : v0x * tCap + 0.5 * AIR_ACCEL_PX * tCap * tCap + MAX_RUN * (t - tCap);
    return Math.max(0, d / TILE - 0.4);
  }

  it("the true maximum is never below the old formula's answer", () => {
    for (const runwayTiles of RUNWAYS) {
      const spec = solveJump({ runwayTiles, deltaYTiles: 0 });
      expect(spec.ultraTiles).toBeGreaterThan(legacyMaxGap(runwayTiles, 0));
    }
  });

  it("the old formula under-reported by more than a tile with real runway", () => {
    for (const runwayTiles of [1, 2, 4, 7]) {
      const spec = solveJump({ runwayTiles, deltaYTiles: 0 });
      expect(spec.ultraTiles - legacyMaxGap(runwayTiles, 0)).toBeGreaterThan(1);
    }
  });
});

describe("geometry constraints", () => {
  it("a low ceiling over the runway shortens the jump", () => {
    const open = solveJump({ runwayTiles: 4, deltaYTiles: 0 });
    const capped = solveJump({
      runwayTiles: 4,
      deltaYTiles: 0,
      ceilingTiles: 2,
    });
    expect(capped.ultraTiles).toBeLessThan(open.ultraTiles);
    expect(capped.ultraTiles).toBeGreaterThan(0);
  });

  it("a target above the jump apex is unreachable at any timing", () => {
    const spec = solveJump({ runwayTiles: 7, deltaYTiles: 12 });
    expect(spec.ultraTiles).toBe(0);
  });
});

describe("performance", () => {
  it("a cold solve is fast enough to sit behind a tool call", () => {
    const t0 = Date.now();
    solveJump({ runwayTiles: 5, deltaYTiles: -3 });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("repeat solves are memoized", () => {
    solveJump({ runwayTiles: 6, deltaYTiles: -1 });
    const t0 = Date.now();
    for (let i = 0; i < 200; i++)
      solveJump({ runwayTiles: 6, deltaYTiles: -1 });
    expect(Date.now() - t0).toBeLessThan(50);
  });
});
