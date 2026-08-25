/**
 * Deterministic level-reachability checker built on the frame-accurate
 * jump solver.
 *
 * Models the level as a graph of "standable" cells (empty cell with solid
 * ground directly beneath) connected by walk, fall, and jump edges whose
 * limits come from the solved capability ladder — including how much
 * runway the takeoff platform actually provides.
 *
 * What a PASS means depends on the tier: at GUARANTEED it means any
 * competent player finishes the level, at EXPERT it means a skilled player
 * with tight timing can. That is a weaker guarantee than this checker used
 * to make, and it is only safe because the tier is now explicit — EASY
 * levels still get the old promise.
 *
 * Pure and Phaser-free so it can be unit-tested on toy grids.
 *
 * Known simplifications (all conservative or rare in this game's levels):
 * - Jumps check takeoff-column headroom but not full arc clearance.
 * - Falls are straight down one column; no mid-fall steering.
 * - Rising jumps pay a 2-tiles-of-gap-per-tile-of-rise penalty.
 */
import type { JumpTier } from "../phaser/jumpSolver";
import {
  currentTier,
  maxGapForRunway,
  movementFacts,
  RUNWAY_RUNGS,
} from "../phaser/movementCapabilities";

export interface TileGridView {
  width: number;
  height: number;
  /** True if the cell blocks movement / supports standing. */
  isSolid(x: number, y: number): boolean;
}

export interface Cell {
  x: number;
  y: number;
}

export interface ReachabilityResult {
  /** Keys "x,y" of every reachable standable cell. */
  reachable: Set<string>;
  /** All standable cells found in the grid. */
  standableCount: number;
  /** Human/LLM-readable explanations for unreachable regions. */
  diagnoses: string[];
}

const key = (x: number, y: number) => `${x},${y}`;
/** Runway is capped: beyond the last ladder rung more run-up adds nothing. */
const MAX_RUNWAY = RUNWAY_RUNGS[RUNWAY_RUNGS.length - 1];

export function isStandable(g: TileGridView, x: number, y: number): boolean {
  return (
    x >= 0 &&
    x < g.width &&
    y >= 0 &&
    y + 1 < g.height &&
    !g.isSolid(x, y) &&
    g.isSolid(x, y + 1)
  );
}

/** Flat run-up available on the takeoff platform, moving toward `dir`. */
function runwayAt(g: TileGridView, x: number, y: number, dir: 1 | -1): number {
  let runway = 0;
  while (runway < MAX_RUNWAY && isStandable(g, x - dir * (runway + 1), y)) {
    runway++;
  }
  return runway;
}

/** Vertical clearance above a cell (tiles of empty space, capped). */
function headroomAt(
  g: TileGridView,
  x: number,
  y: number,
  needed: number,
): boolean {
  for (let i = 1; i <= needed; i++) {
    if (y - i < 0) return true; // above the map top is open sky
    if (g.isSolid(x, y - i)) return false;
  }
  return true;
}

function neighbors(
  g: TileGridView,
  x: number,
  y: number,
  tier: JumpTier,
): Cell[] {
  const CAPS = movementFacts(tier);
  const out: Cell[] = [];

  for (const dir of [1, -1] as const) {
    const nx = x + dir;

    // Walk (same height) and 1-tile step up — trivial moves.
    if (isStandable(g, nx, y)) out.push({ x: nx, y });
    if (isStandable(g, nx, y - 1) && !g.isSolid(x, y - 1)) {
      out.push({ x: nx, y: y - 1 });
    }

    // Fall: walk off the edge and drop to the first standable cell below.
    if (
      nx >= 0 &&
      nx < g.width &&
      !g.isSolid(nx, y) &&
      !isStandable(g, nx, y)
    ) {
      for (let fy = y + 1; fy < g.height; fy++) {
        if (g.isSolid(nx, fy)) break; // landed inside a wall face — stop
        if (isStandable(g, nx, fy)) {
          out.push({ x: nx, y: fy });
          break;
        }
      }
    }

    // Jumps: targets across gaps and/or up ledges, limited by the ladder.
    const runway = runwayAt(g, x, y, dir);
    const allowedGap = maxGapForRunway(runway, tier);
    const maxDx = allowedGap + 1; // gap of N tiles = landing N+1 cells away
    for (let dx = 2; dx <= maxDx; dx++) {
      const tx = x + dir * dx;
      for (let rise = -g.height; rise <= CAPS.maxStepUpTiles; rise++) {
        const ty = y - rise;
        if (!isStandable(g, tx, ty)) continue;
        const gapWidth = dx - 1;
        const allowed =
          rise <= 0 ? allowedGap : Math.max(0, allowedGap - 2 * rise);
        if (gapWidth > allowed) continue;
        if (rise > 0 && !headroomAt(g, x, y, rise + 1)) continue;
        out.push({ x: tx, y: ty });
      }
    }

    // Pure vertical / adjacent step-up beyond 1 tile (dx ≤ 1).
    for (let rise = 2; rise <= CAPS.maxStepUpTiles; rise++) {
      const ty = y - rise;
      for (const tx of [x, nx]) {
        if (isStandable(g, tx, ty) && headroomAt(g, x, y, rise + 1)) {
          out.push({ x: tx, y: ty });
        }
      }
    }
  }
  return out;
}

/** Find the standable cell at or directly below an arbitrary point. */
export function snapToStandable(
  g: TileGridView,
  x: number,
  y: number,
): Cell | null {
  for (let fy = Math.max(0, y); fy < g.height; fy++) {
    if (isStandable(g, x, fy)) return { x, y: fy };
    if (g.isSolid(x, fy)) {
      // Inside/on ground — try the cell above it.
      return isStandable(g, x, fy - 1) ? { x, y: fy - 1 } : null;
    }
  }
  return null;
}

export function computeReachability(
  g: TileGridView,
  start: Cell,
  tier: JumpTier = currentTier(),
): ReachabilityResult {
  const reachable = new Set<string>();
  const startCell = snapToStandable(g, start.x, start.y);
  const allStandable: Cell[] = [];
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      if (isStandable(g, x, y)) allStandable.push({ x, y });
    }
  }

  if (!startCell) {
    return {
      reachable,
      standableCount: allStandable.length,
      diagnoses: [
        `The start position (${start.x}, ${start.y}) has no standable ground at or below it — the player falls out of the level immediately.`,
      ],
    };
  }

  const queue: Cell[] = [startCell];
  reachable.add(key(startCell.x, startCell.y));
  while (queue.length > 0) {
    const cell = queue.pop()!;
    for (const n of neighbors(g, cell.x, cell.y, tier)) {
      const k = key(n.x, n.y);
      if (!reachable.has(k)) {
        reachable.add(k);
        queue.push(n);
      }
    }
  }

  // Group unreachable standable cells into walk-connected islands and
  // diagnose each one relative to the nearest reachable cell.
  const unreachable = allStandable.filter((c) => !reachable.has(key(c.x, c.y)));
  const diagnoses = diagnoseIslands(unreachable, allStandable, reachable, tier);

  return { reachable, standableCount: allStandable.length, diagnoses };
}

function diagnoseIslands(
  unreachable: Cell[],
  allStandable: Cell[],
  reachable: Set<string>,
  tier: JumpTier,
): string[] {
  const CAPS = movementFacts(tier);
  if (unreachable.length === 0) return [];
  const unvisited = new Set(unreachable.map((c) => key(c.x, c.y)));
  const reachableCells = allStandable.filter((c) =>
    reachable.has(key(c.x, c.y)),
  );
  const diagnoses: string[] = [];

  for (const seed of unreachable) {
    const seedKey = key(seed.x, seed.y);
    if (!unvisited.has(seedKey)) continue;
    // Flood the island by walk adjacency (same/±1 height neighbors).
    const island: Cell[] = [];
    const stack = [seed];
    unvisited.delete(seedKey);
    while (stack.length > 0) {
      const c = stack.pop()!;
      island.push(c);
      for (const dx of [-1, 1]) {
        for (const dy of [-1, 0, 1]) {
          const k = key(c.x + dx, c.y + dy);
          if (unvisited.has(k)) {
            unvisited.delete(k);
            stack.push({ x: c.x + dx, y: c.y + dy });
          }
        }
      }
    }

    const xs = island.map((c) => c.x);
    const ys = island.map((c) => c.y);
    const bounds = `x=${Math.min(...xs)}..${Math.max(...xs)}, y=${Math.min(...ys)}..${Math.max(...ys)}`;

    if (reachableCells.length === 0) {
      diagnoses.push(
        `Platform at ${bounds} is unreachable — nothing is reachable from the start.`,
      );
      continue;
    }
    // Nearest reachable cell to any island cell.
    let best: { from: Cell; to: Cell; d: number } | null = null;
    for (const ic of island) {
      for (const rc of reachableCells) {
        const d = Math.abs(ic.x - rc.x) + Math.abs(ic.y - rc.y);
        if (!best || d < best.d) best = { from: rc, to: ic, d };
      }
    }
    const { from, to } = best!;
    const gap = Math.abs(to.x - from.x) - 1;
    const rise = from.y - to.y;
    const details: string[] = [];
    if (rise > CAPS.maxStepUpTiles) {
      details.push(
        `it is ${rise} tiles higher than the nearest reachable ground — the maximum reliable climb is ${CAPS.maxStepUpTiles} tiles`,
      );
    }
    if (gap >= CAPS.impossibleGapTiles) {
      details.push(
        `the ${gap}-tile gap from (${from.x}, ${from.y}) exceeds the absolute maximum of ${CAPS.maxGapTiles} tiles`,
      );
    } else if (gap > 0) {
      details.push(
        `the ${gap}-tile gap from (${from.x}, ${from.y}) needs more run-up than that platform provides` +
          (rise > 0
            ? ` (and the target is ${rise} tiles higher, which shortens jump reach)`
            : ""),
      );
    }
    if (details.length === 0) {
      details.push(
        `no walk, fall, or jump path connects it to reachable ground near (${from.x}, ${from.y})`,
      );
    }
    diagnoses.push(
      `Platform at ${bounds} is unreachable: ${details.join("; ")}.`,
    );
  }
  return diagnoses;
}

/**
 * Convenience: can the player collect an item at (x, y)? True if a
 * reachable standable cell exists in the item's column (or an adjacent
 * one), at the item's row or up to a jump apex below it — i.e. the player
 * can stand there and jump up through the item. Deliberately conservative:
 * items only touchable mid-flight across a gap are reported unreachable,
 * nudging the designer toward safely collectable placements.
 */
export function isCollectableReachable(
  result: ReachabilityResult,
  g: TileGridView,
  x: number,
  y: number,
  tier: JumpTier = currentTier(),
): boolean {
  const maxRise = Math.floor(movementFacts(tier).maxJumpApexTiles);
  for (let dx = -1; dx <= 1; dx++) {
    for (let k = 0; k <= maxRise; k++) {
      const cy = y + k;
      if (cy >= g.height) break;
      if (result.reachable.has(key(x + dx, cy))) return true;
    }
  }
  return false;
}
