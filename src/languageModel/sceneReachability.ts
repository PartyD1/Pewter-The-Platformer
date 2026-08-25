/**
 * Bridges the pure reachability engine (reachability.ts) to a live
 * EditorScene: builds a TileGridView from the Ground_Layer, runs the check
 * from the player spawn, and formats a report for the LLM tools.
 */
import type { EditorScene } from "../phaser/editorScene.ts";
import type { JumpTier } from "../phaser/jumpSolver.ts";
import { classifyJump, currentTier } from "../phaser/movementCapabilities.ts";
import { TILE } from "../phaser/playerPhysics";
import {
  computeReachability,
  isCollectableReachable,
  isStandable,
  type ReachabilityResult,
  type TileGridView,
} from "./reachability.ts";

/** Player spawn/respawn point used by the editor playtest (px). */
const SPAWN_PX = { x: 100, y: 150 };

/** Spawn point in tile coordinates. */
export const SPAWN_TILE = {
  x: Math.floor(SPAWN_PX.x / TILE),
  y: Math.floor(SPAWN_PX.y / TILE),
};

/**
 * Grid view over the Ground_Layer. Editor convention: -1 = empty, 1 = empty
 * marker, >1 = real tile; everything real collides in play mode.
 */
export function buildGridView(scene: EditorScene): TileGridView | null {
  const map = scene.map;
  const ground = scene.groundLayer;
  if (!map || !ground) return null;
  return {
    width: map.width,
    height: map.height,
    isSolid: (x, y) => {
      const t = ground.getTileAt(x, y);
      return !!t && t.index > 1;
    },
  };
}

export interface CompletabilityReport {
  ok: boolean;
  /** LLM-facing report: failures to fix, or a success summary + warnings. */
  text: string;
  /** The hardest tier any required jump in the level actually demands. */
  rating?: JumpTier | "IMPOSSIBLE";
}

/**
 * Rate the level by the hardest jump it actually contains, and count how
 * many near-limit jumps sit next to each other.
 *
 * The hardest single jump is only half the story: three EXPERT jumps in a
 * row is a materially harder level than one, because a miss on any of them
 * costs the whole run. Nothing in the reachability graph can see that, so
 * it is measured here over the standable cells.
 */
function rateLevel(
  grid: TileGridView,
  result: ReachabilityResult,
): { hardest: JumpTier | "IMPOSSIBLE"; nearLimitChains: number } {
  const order: (JumpTier | "IMPOSSIBLE")[] = [
    "GUARANTEED",
    "NORMAL",
    "EXPERT",
    "ULTRA",
    "IMPOSSIBLE",
  ];
  let hardestIdx = 0;
  const hardCells: string[] = [];

  for (const key of result.reachable) {
    const [x, y] = key.split(",").map(Number);
    for (const dir of [1, -1] as const) {
      // How far is the next standable ground in this direction?
      let gap = 0;
      while (gap < 20 && !isStandable(grid, x + dir * (gap + 1), y)) gap++;
      if (gap === 0 || gap >= 20) continue;
      const landing = x + dir * (gap + 1);
      if (!isStandable(grid, landing, y)) continue;
      if (!result.reachable.has(`${landing},${y}`)) continue;

      let runway = 0;
      while (runway < 7 && isStandable(grid, x - dir * (runway + 1), y)) {
        runway++;
      }
      const jumpTier = classifyJump(runway, gap, 0);
      const idx = order.indexOf(jumpTier);
      if (idx > hardestIdx) hardestIdx = idx;
      if (idx >= order.indexOf("EXPERT")) hardCells.push(`${x},${y}`);
    }
  }

  // Consecutive near-limit jumps, measured as hard takeoffs within a few
  // tiles of one another.
  let chains = 0;
  const sorted = hardCells
    .map((k) => k.split(",").map(Number))
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i][0] - sorted[i - 1][0]) <= 14) chains++;
  }

  return {
    hardest: order[hardestIdx] as JumpTier | "IMPOSSIBLE",
    nearLimitChains: chains,
  };
}

export function runCompletabilityCheck(
  scene: EditorScene,
  tier: JumpTier = currentTier(),
): CompletabilityReport {
  const grid = buildGridView(scene);
  if (!grid) {
    return { ok: true, text: "Reachability check skipped — no map loaded." };
  }

  const result = computeReachability(grid, SPAWN_TILE, tier);

  const failures: string[] = [];
  const warnings: string[] = [];

  // A dead spawn is always a failure.
  for (const d of result.diagnoses) {
    if (d.includes("start position")) failures.push(d);
    else warnings.push(d); // unreachable platforms may be decorative
  }

  // Every collectable must be collectable.
  const collectables: { x: number; y: number }[] = [];
  scene.collectablesLayer?.forEachTile((t) => {
    if (t.index > 1) collectables.push({ x: t.x, y: t.y });
  });
  for (const c of collectables) {
    if (!isCollectableReachable(result, grid, c.x, c.y, tier)) {
      failures.push(
        `Collectable at (${c.x}, ${c.y}) cannot be collected — no reachable ground within a jump of it.`,
      );
    }
  }

  const pct =
    result.standableCount > 0
      ? Math.round((100 * result.reachable.size) / result.standableCount)
      : 100;

  const rating = rateLevel(grid, result);

  if (failures.length > 0) {
    return {
      ok: false,
      rating: rating.hardest,
      text:
        "LEVEL NOT COMPLETABLE — fix these with more tool calls, then call verifyComplete again:\n" +
        failures.map((f) => `• ${f}`).join("\n") +
        (warnings.length > 0
          ? "\nAlso unreachable (fix if they matter):\n" +
            warnings.map((w) => `• ${w}`).join("\n")
          : ""),
    };
  }

  const chainNote =
    rating.nearLimitChains > 0
      ? ` ${rating.nearLimitChains} near-limit jump(s) sit close enough together to chain — that compounds the difficulty beyond any single jump.`
      : "";

  return {
    ok: true,
    rating: rating.hardest,
    text:
      `Level verified completable at the ${tier} tier: ${result.reachable.size}/${result.standableCount} standable tiles reachable from spawn (${pct}%); ` +
      `all ${collectables.length} collectable(s) collectable. ` +
      `Hardest required jump: ${rating.hardest}.${chainNote}` +
      (warnings.length > 0
        ? ` Warnings (unreachable side areas — fine if decorative):\n` +
          warnings.map((w) => `• ${w}`).join("\n")
        : ""),
  };
}
