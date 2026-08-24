/**
 * Frame-accurate jump solver — finds the REAL maximum jump distance by
 * searching the actual input space, instead of deriving it from continuous
 * kinematics.
 *
 * See JUMP_SOLVER_REWORK_PLAN.md for the full rationale. The short version:
 * the old closed-form `calculateMaxGap()` under-reported by 1.3–2.0 tiles
 * because it modelled a continuous world with no coyote time and no body
 * width. Pewter's real physics is a discrete frame loop with a 10×14px AABB,
 * and the longest jumps are taken by running *off* the ledge and jumping on
 * the last coyote frame.
 *
 * This module simulates that loop verbatim (importing the same
 * `stepMovement` the live controller uses) and sweeps:
 *   - sub-pixel takeoff phase (where in the frame you reach the ledge)
 *   - jump frame (including every coyote frame past the ledge)
 *   - jump hold duration (matters under ceilings and for rising targets)
 * at 30/60/144fps, reporting the worst case across all three so a jump that
 * qualifies works on every machine.
 *
 * Difficulty is expressed as **jump-timing latitude**: how many milliseconds
 * of slop the player gets on the jump press. That is the number the tiers are
 * built on, and it is what makes "hard level" a definition rather than a
 * feeling.
 *
 * Pure and Phaser-free so it can be unit-tested (see __tests__/jumpSolver.test.ts).
 */
import {
  createMovementState,
  GRAVITY_PX,
  MAX_RUN_SPEED_PX,
  PLAYER_BODY_PX,
  PLAYER_PHYSICS,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  TILE,
} from "./playerPhysics";

const BODY_W = PLAYER_BODY_PX.width;
const BODY_H = PLAYER_BODY_PX.height;

/**
 * Horizontal overlap (px) required with the target tile to count as a
 * landing rather than a corner clip.
 *
 * Arcade separates a tile overlap on the axis of least penetration, so a
 * body that crosses the target's surface with only a hair of x-overlap can
 * be ejected sideways into the pit instead of seated on top. Demanding a
 * full pixel keeps the solver on the safe side of that coin-flip.
 */
const LANDING_OVERLAP_PX = 1;

/** Frame rates the solver must satisfy simultaneously. */
export const SOLVER_FRAME_RATES = [1 / 30, 1 / 60, 1 / 144] as const;

/** Hard cap on simulated frames — a runway of 20 tiles at 144fps is ~200. */
const MAX_FRAMES = 1400;

export type JumpTier = "GUARANTEED" | "NORMAL" | "EXPERT" | "ULTRA";

/** Easiest → hardest. */
export const JUMP_TIERS = [
  "GUARANTEED",
  "NORMAL",
  "EXPERT",
  "ULTRA",
] as const satisfies readonly JumpTier[];

/**
 * Minimum jump-timing slop (milliseconds) a tier leaves the player.
 *
 * Measured in ms, not frames, so the tiers mean the same thing at 30fps and
 * 144fps — human timing precision is wall-clock, not frame-indexed. The
 * reference points are 60fps frames: 150ms ≈ 9 frames, 66ms = 4, 32ms = 2.
 *
 * ULTRA is "any latitude at all at every frame rate" — a single frame of
 * slop at the coarsest rate. It is the literal physical maximum and is
 * deliberately NOT a design target; see `HUMAN_HARD_TIER`.
 */
export const TIER_LATITUDE_MS: Record<JumpTier, number> = {
  GUARANTEED: 150,
  NORMAL: 66,
  EXPERT: 32,
  ULTRA: 0,
};

/**
 * The hardest tier a level should ever *require*.
 *
 * ULTRA is a 1-frame window at 60fps (~16ms) that also depends on a
 * sub-pixel takeoff phase the player cannot see. It is a real physical
 * bound and useful for rejecting impossible geometry, but requiring it is
 * a bug, not a difficulty setting. EXPERT is the honest human ceiling.
 */
export const HUMAN_HARD_TIER: JumpTier = "EXPERT";

export interface JumpSituation {
  /** Flat, unobstructed tiles of run-up before the ledge. */
  runwayTiles: number;
  /** Elevation change to the target: + = target higher, − = target lower. */
  deltaYTiles: number;
  /**
   * Corridor headroom in tiles, spanning the runway and the gap; omitted =
   * open sky. A ceiling that stopped at the ledge would constrain nothing,
   * because the longest jumps launch from past the ledge.
   */
  ceilingTiles?: number;
}

export interface JumpSpectrum {
  /** Largest gap (tiles) clearable at each tier, worst case across rates. */
  guaranteedTiles: number;
  normalTiles: number;
  expertTiles: number;
  /** The literal maximum. Frame-perfect; never require it. */
  ultraTiles: number;
  /** Nothing at or above this width lands, at any timing, at any frame rate. */
  impossibleTiles: number;
  /** Jump-timing slop (ms) available at each tier's gap. */
  latitudeMs: Record<JumpTier, number>;
}

/** One simulated frame, reduced to what the gap math needs. */
interface SimFrame {
  /** Body's right edge, px, relative to the takeoff ledge (ledge = 0). */
  right: number;
  /** Body's bottom edge, px. 0 = takeoff surface, + = below it. */
  bottom: number;
  /** `bottom` on the previous frame — the "came from above" test. */
  prevBottom: number;
  vy: number;
  /** True once the body has lost all contact with the takeoff platform. */
  offPlatform: boolean;
}

/**
 * A half-open span of gap widths (px), `min` exclusive, `max` inclusive,
 * that a single input sequence lands on.
 *
 * A trajectory yields a *list* of these, not one, because the flight can
 * cross the target's surface height more than once. The important case is
 * coyote time: the player runs off the ledge and falls below platform level
 * for a few frames before jumping. That dip crosses the surface height of a
 * level target, but only over gaps of a few pixels — the real target is
 * still far to the right. Treating the dip as "the landing" is what caps
 * the answer at the no-coyote result and hides the whole exploit.
 */
interface GapSpan {
  min: number;
  max: number;
}

/**
 * Simulate one jump attempt.
 *
 * Mirrors the live loop exactly: `stepMovement` → gravity → integrate →
 * resolve, the same order `PlayerController` + Arcade run in. The body
 * starts with its *leading edge* `runwayPx` back from the ledge, and stays
 * supported while any part of it overlaps the platform — down to the last
 * pixel, which is what makes the run-off-the-edge exploit representable.
 */
function simulate(
  dt: number,
  runwayPx: number,
  phasePx: number,
  jumpFrame: number,
  holdFrames: number,
  ceilingY: number | null,
  stopBelowY: number,
): SimFrame[] {
  const state = createMovementState();
  let left = -(runwayPx + BODY_W) + phasePx;
  let bottom = 0;
  let vx = 0;
  let vy = 0;
  let onGround = true;
  let prevJumpHeld = false;
  let everOffPlatform = false;
  const frames: SimFrame[] = [];

  for (let f = 0; f < MAX_FRAMES; f++) {
    const jumpHeld =
      jumpFrame >= 0 && f >= jumpFrame && f < jumpFrame + holdFrames;
    const jumpJustPressed = jumpHeld && !prevJumpHeld;
    prevJumpHeld = jumpHeld;

    const r = stepMovement(
      state,
      { moveInput: 1, jumpHeld, jumpJustPressed },
      vx,
      vy,
      onGround,
      dt,
    );
    vx = r.velocityX;
    vy = r.velocityY;

    // Arcade integrates gravity itself, after the controller runs.
    vy = Math.min(vy + GRAVITY_PX * dt, TERMINAL_VELOCITY_PX);
    const prevBottom = bottom;
    left += vx * dt;
    bottom += vy * dt;

    // Supported while ANY horizontal overlap with the takeoff platform
    // remains — the platform's right edge is x = 0.
    const supported = left < 0;
    if (supported && bottom >= 0 && vy > 0) {
      bottom = 0;
      vy = 0;
      onGround = true;
    } else {
      onGround = supported && bottom === 0 && vy === 0;
    }

    // Corridor ceiling: bonk and lose all upward speed. Spans the runway AND
    // the gap — a ceiling that stopped at the ledge would constrain nothing,
    // since the longest jumps are taken from past the ledge and would simply
    // fly out from under it.
    if (ceilingY !== null && vy < 0 && bottom - BODY_H <= ceilingY) {
      bottom = ceilingY + BODY_H;
      vy = 0;
    }

    if (!supported) everOffPlatform = true;
    frames.push({
      right: left + BODY_W,
      bottom,
      prevBottom,
      vy,
      offPlatform: everOffPlatform,
    });

    if (everOffPlatform && bottom > stopBelowY) break;
  }
  return frames;
}

/**
 * Which gap widths does this trajectory land on?
 *
 * A target of width-`G` sits with its leading face at x = G and its surface
 * at y = `targetY`. The jump resolves at the first frame where the body is
 * simultaneously below that surface and horizontally into the target: if it
 * arrived by descending across the surface that is a landing, otherwise it
 * is the body smacking into the leading face.
 *
 * Rather than re-simulating per candidate gap, we sweep the frames once and
 * let each one "claim" the band of gaps it is the deciding frame for. The
 * body only moves right, so frame f decides every gap between the previous
 * frame's reach and its own.
 */
function gapSpansFor(frames: SimFrame[], targetY: number): GapSpan[] {
  const spans: GapSpan[] = [];
  let cursor = -Infinity; // widest gap already decided by an earlier frame
  for (const fr of frames) {
    if (!fr.offPlatform) continue;
    if (fr.bottom <= targetY) continue; // still above the target surface
    const reach = fr.right - LANDING_OVERLAP_PX;
    if (reach <= cursor) continue; // an earlier frame already decided these
    // Descending across the surface = landing; anything else = face hit.
    if (fr.prevBottom <= targetY && fr.vy > 0) {
      spans.push({ min: cursor, max: reach });
    }
    cursor = reach;
  }
  return spans;
}

function spansContain(spans: GapSpan[], gapPx: number): boolean {
  for (const s of spans) {
    if (gapPx > s.min && gapPx <= s.max) return true;
  }
  return false;
}

/**
 * The exact input sequence that achieves the maximum, so tests (and the
 * Phaser integration check) can replay it against the real engine.
 */
export interface OptimalInput {
  dt: number;
  /** Sub-pixel offset of the starting position, px. */
  phasePx: number;
  /** Frame index the jump is pressed on. */
  jumpFrame: number;
  /** Frame index the body loses contact with the ledge. */
  ledgeFrame: number;
  /** Frames the jump is held (large = full hold). */
  holdFrames: number;
  /** Gap this input clears, in tiles. */
  gapTiles: number;
}

/** Per-frame-rate solve: every input sequence's clearable gap range. */
interface RateSolution {
  /** Best clearable gap (px) over the whole input space. */
  maxGapPx: number;
  /**
   * Landing spans indexed by [inputVariantIndex][jumpFrameOffset]. Contiguity
   * along the inner axis is the jump-timing window.
   */
  variants: GapSpan[][][];
  dt: number;
  /** Input that achieves `maxGapPx`. */
  best: OptimalInput | null;
}

function solveRate(dt: number, s: JumpSituation): RateSolution {
  const runwayPx = Math.max(0, s.runwayTiles) * TILE;
  const targetY = -s.deltaYTiles * TILE;
  const ceilingY = s.ceilingTiles === undefined ? null : -s.ceilingTiles * TILE;
  const stopBelowY = Math.max(targetY, 0) + 200 * TILE;

  // Sub-pixel takeoff phase: one frame of travel at top speed covers every
  // possible alignment with the ledge.
  const phaseStep = 0.25;
  const phases: number[] = [];
  for (let p = 0; p < MAX_RUN_SPEED_PX * dt; p += phaseStep) phases.push(p);
  if (phases.length === 0) phases.push(0);

  // Hold duration only changes the answer when something can stop the rise.
  const FULL_HOLD = 1e9;
  const needsHoldSweep = ceilingY !== null || s.deltaYTiles > 0;
  const holds = needsHoldSweep
    ? [FULL_HOLD, 1, 2, 3, 4, 6, 8, 12, 20]
    : [FULL_HOLD];

  const coyoteFrames = Math.ceil(PLAYER_PHYSICS.COYOTE_TIME / dt) + 2;
  // Enough run-up frames to cover the widest useful timing window.
  const LOOKBACK_FRAMES = Math.ceil(1.6 / dt);

  const variants: GapSpan[][][] = [];
  let maxGapPx = -Infinity;
  let best: OptimalInput | null = null;

  for (const phase of phases) {
    // Where does this phase actually lose contact with the ledge?
    const probe = simulate(dt, runwayPx, phase, -1, 0, ceilingY, stopBelowY);
    let ledgeFrame = probe.findIndex((fr) => fr.offPlatform);
    if (ledgeFrame < 0) ledgeFrame = probe.length - 1;

    const firstJf = Math.max(0, ledgeFrame - LOOKBACK_FRAMES);
    const lastJf = ledgeFrame + coyoteFrames;

    for (const hold of holds) {
      const row: GapSpan[][] = [];
      for (let jf = firstJf; jf <= lastJf; jf++) {
        const frames = simulate(
          dt,
          runwayPx,
          phase,
          jf,
          hold,
          ceilingY,
          stopBelowY,
        );
        const spans = gapSpansFor(frames, targetY);
        row.push(spans);
        for (const sp of spans) {
          if (sp.max > maxGapPx) {
            maxGapPx = sp.max;
            best = {
              dt,
              phasePx: phase,
              jumpFrame: jf,
              ledgeFrame,
              holdFrames: hold,
              gapTiles: sp.max / TILE,
            };
          }
        }
      }
      variants.push(row);
    }
  }

  return {
    maxGapPx: maxGapPx === -Infinity ? 0 : maxGapPx,
    variants,
    dt,
    best,
  };
}

/** The input sequence that achieves the maximum gap at a given frame rate. */
export function findOptimalInput(
  s: JumpSituation,
  dt: number,
): OptimalInput | null {
  return solveRate(dt, s).best;
}

/** Longest contiguous run of jump frames that clears `gapPx`, in ms. */
function latitudeMsFor(sol: RateSolution, gapPx: number): number {
  let best = 0;
  for (const row of sol.variants) {
    let run = 0;
    for (const spans of row) {
      run = spansContain(spans, gapPx) ? run + 1 : 0;
      if (run > best) best = run;
    }
  }
  return best * sol.dt * 1000;
}

/** Worst-case latitude across every frame rate, in ms. */
function worstLatitudeMs(sols: RateSolution[], gapPx: number): number {
  let worst = Infinity;
  for (const sol of sols) worst = Math.min(worst, latitudeMsFor(sol, gapPx));
  return worst;
}

/**
 * Largest gap (px) whose worst-case latitude still meets `thresholdMs`.
 * Bisects between 0 and the known ceiling; latitude is monotonically
 * non-increasing in gap width, which is what makes bisection valid.
 */
function largestGapWithLatitude(
  sols: RateSolution[],
  ceilingPx: number,
  thresholdMs: number,
): number {
  const meets = (g: number) =>
    thresholdMs <= 0
      ? worstLatitudeMs(sols, g) > 0
      : worstLatitudeMs(sols, g) >= thresholdMs;

  if (!meets(0.001)) return 0;
  let lo = 0.001;
  let hi = ceilingPx;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (meets(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const cache = new Map<string, JumpSpectrum>();

function situationKey(s: JumpSituation): string {
  return `${s.runwayTiles}|${s.deltaYTiles}|${s.ceilingTiles ?? "sky"}`;
}

/**
 * Solve a jump situation into its full difficulty spectrum.
 *
 * Memoized — the sweep is ~10⁴ simulated trajectories, tens of milliseconds
 * cold, and callers (the reachability graph especially) hit the same handful
 * of situations over and over.
 */
export function solveJump(s: JumpSituation): JumpSpectrum {
  const key = situationKey(s);
  const hit = cache.get(key);
  if (hit) return hit;

  const sols = SOLVER_FRAME_RATES.map((dt) => solveRate(dt, s));
  // A gap must be clearable at EVERY frame rate.
  const ultraPx = Math.min(...sols.map((r) => r.maxGapPx));

  const gapFor = (tier: JumpTier) =>
    largestGapWithLatitude(sols, ultraPx, TIER_LATITUDE_MS[tier]) / TILE;

  const guaranteedTiles = gapFor("GUARANTEED");
  const normalTiles = gapFor("NORMAL");
  const expertTiles = gapFor("EXPERT");
  const ultraTiles = ultraPx / TILE;

  const spectrum: JumpSpectrum = {
    guaranteedTiles,
    normalTiles,
    expertTiles,
    ultraTiles,
    impossibleTiles: Math.floor(ultraTiles) + 1,
    latitudeMs: {
      GUARANTEED: worstLatitudeMs(sols, guaranteedTiles * TILE),
      NORMAL: worstLatitudeMs(sols, normalTiles * TILE),
      EXPERT: worstLatitudeMs(sols, expertTiles * TILE),
      ULTRA: worstLatitudeMs(sols, ultraTiles * TILE),
    },
  };
  cache.set(key, spectrum);
  return spectrum;
}

/** Jump-timing slop (ms) the player gets on this exact jump. 0 = impossible. */
export function latitudeForGap(s: JumpSituation, gapTiles: number): number {
  const key = `lat|${situationKey(s)}`;
  let sols = rateCache.get(key);
  if (!sols) {
    sols = SOLVER_FRAME_RATES.map((dt) => solveRate(dt, s));
    rateCache.set(key, sols);
  }
  return worstLatitudeMs(sols, gapTiles * TILE);
}

const rateCache = new Map<string, RateSolution[]>();

/** Which tier does this specific gap fall into? */
export function tierForGap(
  s: JumpSituation,
  gapTiles: number,
): JumpTier | "IMPOSSIBLE" {
  const ms = latitudeForGap(s, gapTiles);
  if (ms <= 0) return "IMPOSSIBLE";
  if (ms >= TIER_LATITUDE_MS.GUARANTEED) return "GUARANTEED";
  if (ms >= TIER_LATITUDE_MS.NORMAL) return "NORMAL";
  if (ms >= TIER_LATITUDE_MS.EXPERT) return "EXPERT";
  return "ULTRA";
}

/** The gap field of a spectrum for a given tier. */
export function gapForTier(spec: JumpSpectrum, tier: JumpTier): number {
  switch (tier) {
    case "GUARANTEED":
      return spec.guaranteedTiles;
    case "NORMAL":
      return spec.normalTiles;
    case "EXPERT":
      return spec.expertTiles;
    case "ULTRA":
      return spec.ultraTiles;
  }
}
