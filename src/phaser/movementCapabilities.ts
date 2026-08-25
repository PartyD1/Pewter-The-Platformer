/**
 * Design-facing movement facts, derived from the frame-accurate jumpSolver.
 *
 * This is the single source of truth for "what can the player actually do",
 * consumed by the reachability checker, the AI's system prompt, and the
 * calculateJumpGaps tool. Nothing here is hand-written: every number comes
 * from simulating the live `stepMovement` against real collision rules, so
 * retuning `PLAYER_PHYSICS` propagates automatically.
 *
 * It lives in its own module rather than in playerPhysics.ts because the
 * solver imports playerPhysics — putting these there would be a cycle.
 * That separation also keeps the game's hot path free of solver code.
 *
 * EVERYTHING IS LAZY. A full solve is ~100ms and the ladders need a dozen of
 * them; the running game must never pay that just to read a gravity
 * constant. Call the accessors, don't hoist their results to module scope.
 */
import {
  gapForTier,
  HUMAN_HARD_TIER,
  type JumpTier,
  latitudeForGap,
  solveJump,
  tierForGap,
} from "./jumpSolver";
import {
  GROUND_FRICTION_PX,
  MAX_RUN_SPEED_PX,
  PLAYER_BODY_PX,
  PLAYER_PHYSICS,
  TILE,
} from "./playerPhysics";

/**
 * How hard a level is allowed to be. Gates the hardest jump the level may
 * *require* on its critical path.
 */
export type LevelDifficulty = "EASY" | "NORMAL" | "HARD" | "BRUTAL";

export const LEVEL_DIFFICULTIES = [
  "EASY",
  "NORMAL",
  "HARD",
  "BRUTAL",
] as const satisfies readonly LevelDifficulty[];

/**
 * Difficulty → the hardest jump tier that difficulty may require.
 *
 * BRUTAL reaches ULTRA, which is a frame-perfect window that also depends on
 * a sub-pixel takeoff phase the player cannot see. It exists so the dial has
 * a top end and so geometry can be checked against the true physical bound —
 * but a BRUTAL jump belongs on an optional route, never on the critical
 * path. HARD (→ EXPERT) is the honest human ceiling; see `HUMAN_HARD_TIER`.
 */
export const DIFFICULTY_TIER: Record<LevelDifficulty, JumpTier> = {
  EASY: "GUARANTEED",
  NORMAL: "NORMAL",
  HARD: "EXPERT",
  BRUTAL: "ULTRA",
};

export const DEFAULT_DIFFICULTY: LevelDifficulty = "NORMAL";

/**
 * The difficulty the level currently being edited is built to.
 *
 * Module-level rather than threaded through every call because the same
 * answer has to reach the reachability graph, the world-facts narrator, the
 * system prompt, and the tool — all of which are reached from different
 * places in the editor. Set it once when the level's difficulty is chosen.
 */
let currentDifficulty: LevelDifficulty = DEFAULT_DIFFICULTY;

export function getLevelDifficulty(): LevelDifficulty {
  return currentDifficulty;
}

export function setLevelDifficulty(d: LevelDifficulty): void {
  currentDifficulty = d;
}

/** The hardest jump tier the current level may require. */
export function currentTier(): JumpTier {
  return DIFFICULTY_TIER[currentDifficulty];
}

/** True if this difficulty requires jumps beyond the human-honest ceiling. */
export function isBeyondHumanCeiling(d: LevelDifficulty): boolean {
  return DIFFICULTY_TIER[d] === "ULTRA" && HUMAN_HARD_TIER !== "ULTRA";
}

/** Runway sample points for the crossability ladder (tiles of run-up). */
export const RUNWAY_RUNGS = [0, 1, 2, 4, 7] as const;

/** Beyond this much run-up the player is already at top speed. */
export const MAX_RUNWAY = RUNWAY_RUNGS[RUNWAY_RUNGS.length - 1];

export interface GapRung {
  runwayTiles: number;
  /** Whole tiles of gap crossable with this much run-up. */
  gapTiles: number;
}

const ladderCache = new Map<JumpTier, GapRung[]>();

/**
 * Crossability ladder for a tier: run-up available → whole-tile gap
 * crossable. Floored, because levels are built on a tile grid.
 */
export function gapLadder(tier: JumpTier): GapRung[] {
  const hit = ladderCache.get(tier);
  if (hit) return hit;
  const rungs = RUNWAY_RUNGS.map((runwayTiles) => ({
    runwayTiles,
    gapTiles: Math.floor(
      gapForTier(solveJump({ runwayTiles, deltaYTiles: 0 }), tier),
    ),
  }));
  ladderCache.set(tier, rungs);
  return rungs;
}

/** Largest whole-tile gap crossable at `tier` given `runwayTiles` of run-up. */
export function maxGapForRunway(runwayTiles: number, tier: JumpTier): number {
  let best = 0;
  for (const rung of gapLadder(tier)) {
    if (runwayTiles >= rung.runwayTiles) best = rung.gapTiles;
  }
  return best;
}

/** Minimum run-up needed for a gap at `tier`, or null if out of reach. */
export function runwayNeededForGap(
  gapTiles: number,
  tier: JumpTier,
): number | null {
  for (const rung of gapLadder(tier)) {
    if (rung.gapTiles >= gapTiles) return rung.runwayTiles;
  }
  return null;
}

/**
 * Gaps this wide or wider are impossible on ANY machine at ANY timing.
 *
 * Note this is deliberately *not* `ultraTiles + 1`: the requirable tiers are
 * worst-case-across-frame-rates, while an impossibility claim has to hold
 * for the best case too, or the reachability checker invents dead ends that
 * a 144Hz player walks straight past.
 */
export function impossibleGapTiles(): number {
  return solveJump({ runwayTiles: MAX_RUNWAY, deltaYTiles: 0 }).impossibleTiles;
}

/** Search bound for climb probes — nothing can exceed the geometric apex. */
const MAX_PROBE_RISE = Math.ceil(PLAYER_PHYSICS.JUMP_HEIGHT) + 2;

/**
 * Tallest ledge climbable at `tier`, measured as "can still land at least a
 * tile out while rising this far". Solver-derived, same engine as the gaps.
 */
export function maxStepUpTiles(tier: JumpTier): number {
  for (let rise = MAX_PROBE_RISE; rise >= 0; rise--) {
    const spec = solveJump({ runwayTiles: MAX_RUNWAY, deltaYTiles: rise });
    if (gapForTier(spec, tier) >= 1) return rise;
  }
  return 0;
}

/** Walls this tall or taller can never be climbed, on any machine. */
export function impossibleWallTiles(): number {
  for (let rise = 0; rise <= MAX_PROBE_RISE + 2; rise++) {
    const spec = solveJump({ runwayTiles: MAX_RUNWAY, deltaYTiles: rise });
    if (spec.bestCaseUltraTiles < 1) return rise;
  }
  return MAX_PROBE_RISE + 2;
}

export interface MovementFacts {
  tier: JumpTier;
  /** Body footprint in tiles (smaller than one tile in both axes). */
  playerSizeTiles: { width: number; height: number };
  /** Geometric jump apex (tiles). */
  maxJumpApexTiles: number;
  /** Ledge height climbable at this tier. */
  maxStepUpTiles: number;
  /** Absolute maximum climbable ledge — frame-perfect, expert only. */
  expertStepUpTiles: number;
  /** Walls this tall (or taller) can NEVER be climbed. */
  impossibleWallTiles: number;
  /** Gap crossable from a standstill at this tier. */
  standingGapTiles: number;
  /** Gap crossable with ample run-up at this tier. */
  maxGapTiles: number;
  /** Gaps this wide (or wider) can NEVER be crossed, on any machine. */
  impossibleGapTiles: number;
  /** Crossability ladder: runway available → crossable gap. */
  gapForRunway: GapRung[];
  /** Tiles needed to stop after landing at full speed. */
  stopDistanceTiles: number;
  /**
   * The body is narrower than a tile, so a 1-tile hole in the floor is a
   * real hazard the player can fall through.
   */
  fallsThroughOneTileGap: boolean;
}

const factsCache = new Map<JumpTier, MovementFacts>();

/** Full movement fact-sheet for a tier. Memoized; first call is ~1s. */
export function movementFacts(tier: JumpTier): MovementFacts {
  const hit = factsCache.get(tier);
  if (hit) return hit;

  const ladder = gapLadder(tier);
  const facts: MovementFacts = {
    tier,
    playerSizeTiles: {
      width: PLAYER_BODY_PX.width / TILE,
      height: PLAYER_BODY_PX.height / TILE,
    },
    maxJumpApexTiles: PLAYER_PHYSICS.JUMP_HEIGHT,
    maxStepUpTiles: maxStepUpTiles(tier),
    expertStepUpTiles: maxStepUpTiles("ULTRA"),
    impossibleWallTiles: impossibleWallTiles(),
    standingGapTiles: ladder[0].gapTiles,
    maxGapTiles: ladder[ladder.length - 1].gapTiles,
    impossibleGapTiles: impossibleGapTiles(),
    gapForRunway: ladder,
    stopDistanceTiles: Math.ceil(
      MAX_RUN_SPEED_PX ** 2 / (2 * GROUND_FRICTION_PX) / TILE,
    ),
    fallsThroughOneTileGap: PLAYER_BODY_PX.width < TILE,
  };
  factsCache.set(tier, facts);
  return facts;
}

/** Movement facts for a level difficulty. */
export function movementFactsFor(d: LevelDifficulty): MovementFacts {
  return movementFacts(DIFFICULTY_TIER[d]);
}

/** Movement facts for the level currently being edited. */
export function currentFacts(): MovementFacts {
  return movementFacts(currentTier());
}

/** One landable position relative to the takeoff ledge. */
export interface ReachableTarget {
  /** Elevation change: + = target higher than takeoff. */
  deltaYTiles: number;
  /** Widest whole-tile gap landable at this elevation, at this tier. */
  gapTiles: number;
  /** Timing slack the player gets on that exact placement. */
  timingSlackMs: number;
}

/** How far below the takeoff ledge the frontier bothers to look. */
const FRONTIER_MIN_RISE = -8;

const frontierCache = new Map<string, ReachableTarget[]>();

/**
 * Every elevation the player can land at from `runwayTiles` of run-up, with
 * the widest gap available at each.
 *
 * This exists because the rest of the API can only *verify* a jump you have
 * already chosen. "Put a platform as high and as far as possible" is an
 * optimisation over two dimensions, and answering it by guess-and-check
 * burns the agent's whole round budget. The frontier answers it in one call.
 *
 * Rising and reaching trade off against each other, so there is no single
 * "furthest" point — the caller picks off the returned curve. Ordered
 * highest-first, which is the order a level designer thinks in.
 */
export function reachableFrontier(
  runwayTiles: number,
  tier: JumpTier,
): ReachableTarget[] {
  const key = `${runwayTiles}|${tier}`;
  const hit = frontierCache.get(key);
  if (hit) return hit;

  const out: ReachableTarget[] = [];
  for (let rise = MAX_PROBE_RISE; rise >= FRONTIER_MIN_RISE; rise--) {
    const situation = { runwayTiles, deltaYTiles: rise };
    const gapTiles = Math.floor(gapForTier(solveJump(situation), tier));
    if (gapTiles < 1) continue;
    out.push({
      deltaYTiles: rise,
      gapTiles,
      // Slack for the whole-tile placement actually being proposed, not for
      // the fractional bound it was floored from.
      timingSlackMs: Math.round(latitudeForGap(situation, gapTiles)),
    });
  }
  frontierCache.set(key, out);
  return out;
}

/** The highest a player can get from this runway (ties broken by reach). */
export function highestReachable(
  runwayTiles: number,
  tier: JumpTier,
): ReachableTarget | null {
  return reachableFrontier(runwayTiles, tier)[0] ?? null;
}

/** The furthest a player can reach from this runway, at any elevation. */
export function furthestReachable(
  runwayTiles: number,
  tier: JumpTier,
): ReachableTarget | null {
  let best: ReachableTarget | null = null;
  for (const t of reachableFrontier(runwayTiles, tier)) {
    if (!best || t.gapTiles > best.gapTiles) best = t;
  }
  return best;
}

/**
 * Classify a concrete jump the level actually contains. Used to rate a
 * finished level by its hardest required jump.
 */
export function classifyJump(
  runwayTiles: number,
  gapTiles: number,
  deltaYTiles: number,
): JumpTier | "IMPOSSIBLE" {
  return tierForGap({ runwayTiles, deltaYTiles }, gapTiles);
}
