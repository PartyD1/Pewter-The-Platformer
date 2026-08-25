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
 * Phaser's `World.TILE_BIAS` default.
 *
 * `TileCheckY` refuses to separate vertically when the body has sunk more
 * than this far into the tile in one frame (it assumes the body tunnelled in
 * from somewhere else), so a landing that arrives deeper than TILE_BIAS
 * simply falls through.
 */
const TILE_BIAS_PX = 16;

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
  /**
   * Largest gap (tiles) clearable at each tier, WORST case across frame
   * rates — i.e. safe to require, because it works on every machine.
   */
  guaranteedTiles: number;
  normalTiles: number;
  expertTiles: number;
  /** The literal maximum that still works everywhere. Never require it. */
  ultraTiles: number;
  /**
   * The absolute physical ceiling, BEST case across frame rates.
   *
   * Deliberately a different statistic from `ultraTiles`. "Can I require
   * this?" is a question about the worst machine; "is this flatly
   * impossible?" is a question about the best one. Deriving the impossible
   * bound from the worst case would declare gaps unreachable that a 144Hz
   * player clears comfortably — and the reachability checker would then
   * report false dead ends.
   */
  bestCaseUltraTiles: number;
  /** Nothing at or above this width lands, at any timing, on ANY machine. */
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
  vy: number;
  /** True once the body has lost all contact with the takeoff platform. */
  offPlatform: boolean;
  /**
   * Index of the RENDERED frame this physics step belongs to. Several steps
   * can share one render frame (or none at all above 60fps), so this is the
   * only safe way to talk about jump timing, which is sampled per render
   * frame.
   */
  renderFrame: number;
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
 * Fixed physics timestep, in seconds.
 *
 * Arcade is a FIXED-STEP simulation: `Phaser.Physics.Arcade.World` defaults
 * to `fps: 60` with `fixedStep: true` (see World.js), so gravity, position
 * integration and tile collision always advance in 1/60 slices no matter what
 * the display is doing. A 30Hz monitor does not integrate at 1/30 — it runs
 * two 1/60 steps per rendered frame.
 *
 * Only the CONTROLLER runs at the render rate: `PlayerController.update()` is
 * called once per rendered frame with the render delta, so input sampling,
 * the coyote/jump-buffer timers, and horizontal acceleration are what vary
 * with frame rate.
 *
 * Conflating the two is not a harmless simplification. Integrating position
 * at 1/30 makes the body descend ~23px per step during a deep fall, which
 * exceeds `TILE_BIAS` and makes the solver believe the player tunnels
 * straight through the target platform. That produced a phantom result where
 * a 4-tile drop had exactly one landable jump frame at "30fps" while 60 and
 * 144 were completely healthy.
 */
const PHYSICS_DT = 1 / 60;

/**
 * Simulate one jump attempt.
 *
 * Mirrors the live loop: `stepMovement` at the render rate, then as many
 * fixed 1/60 Arcade steps (gravity → integrate → resolve) as that render
 * frame's elapsed time buys. The body starts with its *leading edge*
 * `runwayPx` back from the ledge, and stays supported while any part of it
 * overlaps the platform — down to the last pixel, which is what makes the
 * run-off-the-edge exploit representable.
 *
 * One `SimFrame` is recorded per physics step, not per rendered frame, so
 * landing detection sees every position the body actually occupied. The
 * jump-timing axis is unaffected: that is indexed by rendered frame, which
 * is when input is sampled.
 */
function simulate(
  renderDt: number,
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
  let accumulator = 0;
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
      renderDt,
    );
    vx = r.velocityX;
    vy = r.velocityY;

    let done = false;
    accumulator += renderDt;
    while (accumulator >= PHYSICS_DT - 1e-9) {
      accumulator -= PHYSICS_DT;

      vy = Math.min(vy + GRAVITY_PX * PHYSICS_DT, TERMINAL_VELOCITY_PX);
      left += vx * PHYSICS_DT;
      bottom += vy * PHYSICS_DT;

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

      // Corridor ceiling: bonk and lose all upward speed. Spans the runway
      // AND the gap — a ceiling that stopped at the ledge would constrain
      // nothing, since the longest jumps are taken from past the ledge and
      // would simply fly out from under it.
      if (ceilingY !== null && vy < 0 && bottom - BODY_H <= ceilingY) {
        bottom = ceilingY + BODY_H;
        vy = 0;
      }

      if (!supported) everOffPlatform = true;
      frames.push({
        right: left + BODY_W,
        bottom,
        vy,
        offPlatform: everOffPlatform,
        renderFrame: f,
      });

      if (everOffPlatform && bottom > stopBelowY) {
        done = true;
        break;
      }
    }
    if (done) break;
  }
  return frames;
}

/**
 * Which gap widths does this trajectory land on?
 *
 * A gap of `G` puts the target's leading face at x = G and its surface at
 * y = `targetY`. The jump resolves on the first frame the body overlaps that
 * target box, and the outcome is decided the way Phaser's `SeparateTile`
 * decides it: compare how far the body has sunk below the surface against
 * how far it has pushed past the face, and separate on whichever axis is
 * *less* penetrated. Sink less than you overlap and you get seated on top;
 * sink more and you get shoved back out into the pit.
 *
 * That is far more forgiving than "must cross the surface cleanly from
 * above" — Arcade lands corner clips routinely, and modelling it any other
 * way under-reports the true maximum. (Verified against the real engine in
 * __tests__/jumpSolverEngine.test.ts, which is what caught the earlier,
 * stricter rule.)
 *
 * Rather than re-simulating per candidate gap, we sweep the frames once and
 * let each one claim the band of gaps it is the deciding frame for: the body
 * only ever moves right, so frame f decides every gap between the previous
 * frame's reach and its own. Within that band the landing condition
 * `sink ≤ overlap` rearranges to `G ≤ right − sink`, giving the band's
 * landing sub-range in closed form.
 */
function gapSpansFor(frames: SimFrame[], targetY: number): GapSpan[] {
  const spans: GapSpan[] = [];
  let cursor = -Infinity; // widest gap already decided by an earlier frame
  for (const fr of frames) {
    if (!fr.offPlatform) continue;
    if (fr.bottom <= targetY) continue; // still above the target surface
    if (fr.right <= cursor) continue; // an earlier frame already decided these
    const sink = fr.bottom - targetY;
    if (fr.vy > 0 && sink <= TILE_BIAS_PX) {
      const max = fr.right - sink;
      if (max > cursor) spans.push({ min: cursor, max });
    }
    cursor = fr.right;
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
  /**
   * The concrete input parameters behind each variants row, so a landing
   * span found in the table can be replayed as an actual input sequence
   * (jumpFrame = firstJf + the span's inner index).
   */
  variantInputs: {
    phasePx: number;
    holdFrames: number;
    firstJf: number;
    ledgeFrame: number;
  }[];
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
  // possible alignment with the ledge. Quarter-pixel steps, because a
  // coarser sweep quietly costs real reach — at 1px, runway=1 lost enough
  // to drop a whole tile off the GUARANTEED rung.
  const phaseStep = 0.25;
  const phases: number[] = [];
  for (let p = 0; p < MAX_RUN_SPEED_PX * dt; p += phaseStep) phases.push(p);
  if (phases.length === 0) phases.push(0);

  /**
   * Hold duration only matters under a ceiling.
   *
   * Cutting a jump short can only reduce apex AND airtime, so with open sky
   * a full hold strictly dominates for reaching anything — including targets
   * above you. Sweeping holds for every rising target was costing 7x for
   * results that never won.
   */
  const FULL_HOLD = 1e9;
  const holds =
    ceilingY !== null ? [FULL_HOLD, 1, 2, 3, 5, 8, 14] : [FULL_HOLD];

  const coyoteFrames = Math.ceil(PLAYER_PHYSICS.COYOTE_TIME / dt) + 2;
  /**
   * How far before the ledge to start trying the jump.
   *
   * Must cover the widest timing window we report (GUARANTEED, 150ms) with
   * room to spare; jumping earlier than this is never optimal, since the
   * player just lands back on the runway. Scaling this by 1/dt is why an
   * early version took 13s per solve at 144fps — it was sweeping 230 frames
   * of pointless run-up for every phase.
   */
  const LOOKBACK_FRAMES = Math.ceil(0.6 / dt);

  const variants: GapSpan[][][] = [];
  const variantInputs: RateSolution["variantInputs"] = [];
  let maxGapPx = -Infinity;
  let best: OptimalInput | null = null;

  for (const phase of phases) {
    // Where does this phase actually lose contact with the ledge?
    const probe = simulate(dt, runwayPx, phase, -1, 0, ceilingY, stopBelowY);
    // In RENDER frames — that is the axis jump timing lives on.
    const ledgeStep = probe.find((fr) => fr.offPlatform);
    const ledgeFrame = ledgeStep
      ? ledgeStep.renderFrame
      : (probe[probe.length - 1]?.renderFrame ?? 0);

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
      variantInputs.push({
        phasePx: phase,
        holdFrames: hold,
        firstJf,
        ledgeFrame,
      });
    }
  }

  return {
    maxGapPx: maxGapPx === -Infinity ? 0 : maxGapPx,
    variants,
    variantInputs,
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

/**
 * An input sequence that lands a SPECIFIC gap at a given frame rate, or
 * null if no input clears it.
 *
 * `findOptimalInput` answers "what clears the most?", which is the wrong
 * replay for a floored whole-tile placement: on a rising target the
 * max-gap trajectory can smack the face of a *nearer* platform, because
 * the landable set is a band, not a prefix. Replaying a proposed placement
 * against the real engine needs the input that lands that exact gap.
 */
export function findInputForGap(
  s: JumpSituation,
  gapTiles: number,
  dt: number,
): OptimalInput | null {
  const sol = solveRate(dt, s);
  const gapPx = gapTiles * TILE;
  for (let v = 0; v < sol.variants.length; v++) {
    const row = sol.variants[v];
    for (let j = 0; j < row.length; j++) {
      if (spansContain(row[j], gapPx)) {
        const inp = sol.variantInputs[v];
        return {
          dt,
          phasePx: inp.phasePx,
          jumpFrame: inp.firstJf + j,
          ledgeFrame: inp.ledgeFrame,
          holdFrames: inp.holdFrames,
          gapTiles,
        };
      }
    }
  }
  return null;
}

/** Widest gap (tiles) clearable at one specific frame rate. */
export function maxGapAtRate(s: JumpSituation, dt: number): number {
  return solveRate(dt, s).maxGapPx / TILE;
}

/** Jump-timing slop (ms) at one specific frame rate. Diagnostics only. */
export function latitudeAtRate(
  s: JumpSituation,
  gapTiles: number,
  dt: number,
): number {
  return latitudeMsFor(solveRate(dt, s), gapTiles * TILE);
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

/** Resolution of the gap scan below. One pixel = 1/16 tile. */
const GAP_SCAN_STEP_PX = 1;

/**
 * Largest gap (px) whose worst-case latitude still meets `thresholdMs`.
 *
 * Scans downward from the known ceiling rather than bisecting. Bisection
 * looks tempting and is WRONG here, for two independent reasons:
 *
 * 1. Narrow gaps are not always easier. When the target is HIGHER than the
 *    takeoff, its leading face is a wall — a gap narrower than the player's
 *    reach at that height puts the wall where the body still is, and the
 *    jump smacks into it. So the landable set is a band, not a prefix, and
 *    a bisection anchored at "gap ≈ 0 must work" bails out and reports zero.
 * 2. Latitude is the longest *contiguous* run of working jump frames. As the
 *    gap widens, frames drop out of the middle of a run as readily as off
 *    the end, so the run length can wobble rather than decay cleanly.
 *
 * The earlier bisection produced nonsense on exactly these cases: a 1-tile
 * rise reported a NORMAL gap of 0 against an ULTRA gap of 12.08, and a
 * 4-tile drop reported 4.73 against 14.42. Flat ground happened to satisfy
 * both assumptions, which is why the level-target ladder looked right and
 * hid the bug.
 *
 * A linear scan makes no assumption about the shape of the function at all.
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

  for (let g = ceilingPx; g > 0; g -= GAP_SCAN_STEP_PX) {
    if (meets(g)) return g;
  }
  return 0;
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
  // Requirable = clearable at EVERY frame rate. Impossible = clearable at
  // NONE of them. Two different statistics over the same solve.
  const ultraPx = Math.min(...sols.map((r) => r.maxGapPx));
  const bestCaseUltraPx = Math.max(...sols.map((r) => r.maxGapPx));

  const gapFor = (tier: JumpTier) =>
    largestGapWithLatitude(sols, ultraPx, TIER_LATITUDE_MS[tier]) / TILE;

  const guaranteedTiles = gapFor("GUARANTEED");
  const normalTiles = gapFor("NORMAL");
  const expertTiles = gapFor("EXPERT");
  const ultraTiles = ultraPx / TILE;
  const bestCaseUltraTiles = bestCaseUltraPx / TILE;

  const spectrum: JumpSpectrum = {
    guaranteedTiles,
    normalTiles,
    expertTiles,
    ultraTiles,
    bestCaseUltraTiles,
    impossibleTiles: Math.floor(bestCaseUltraTiles) + 1,
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
