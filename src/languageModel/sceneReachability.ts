/**
 * Bridges the pure reachability engine (reachability.ts) to a live
 * EditorScene: builds a TileGridView from the Ground_Layer, runs the check
 * from the player spawn, and formats a report for the LLM tools.
 */
import type { EditorScene } from "../phaser/editorScene.ts";
import { TILE } from "../phaser/playerPhysics";
import {
  computeReachability,
  isCollectableReachable,
  type TileGridView,
} from "./reachability.ts";

/** Player spawn/respawn point used by the editor playtest (px). */
const SPAWN_PX = { x: 100, y: 150 };

export interface CompletabilityReport {
  ok: boolean;
  /** LLM-facing report: failures to fix, or a success summary + warnings. */
  text: string;
}

export function runCompletabilityCheck(
  scene: EditorScene,
): CompletabilityReport {
  const map = scene.map;
  const ground = scene.groundLayer;
  if (!map || !ground) {
    return { ok: true, text: "Reachability check skipped — no map loaded." };
  }

  const grid: TileGridView = {
    width: map.width,
    height: map.height,
    // Editor convention: -1 = empty, 1 = empty marker, >1 = real tile.
    // Everything real on Ground_Layer collides in play mode.
    isSolid: (x, y) => {
      const t = ground.getTileAt(x, y);
      return !!t && t.index > 1;
    },
  };

  const start = {
    x: Math.floor(SPAWN_PX.x / TILE),
    y: Math.floor(SPAWN_PX.y / TILE),
  };
  const result = computeReachability(grid, start);

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
    if (!isCollectableReachable(result, grid, c.x, c.y)) {
      failures.push(
        `Collectable at (${c.x}, ${c.y}) cannot be collected — no reachable ground within a jump of it.`,
      );
    }
  }

  const pct =
    result.standableCount > 0
      ? Math.round((100 * result.reachable.size) / result.standableCount)
      : 100;

  if (failures.length > 0) {
    return {
      ok: false,
      text:
        "LEVEL NOT COMPLETABLE — fix these with more tool calls, then call verifyComplete again:\n" +
        failures.map((f) => `• ${f}`).join("\n") +
        (warnings.length > 0
          ? "\nAlso unreachable (fix if they matter):\n" +
            warnings.map((w) => `• ${w}`).join("\n")
          : ""),
    };
  }

  return {
    ok: true,
    text:
      `Level verified completable: ${result.reachable.size}/${result.standableCount} standable tiles reachable from spawn (${pct}%); ` +
      `all ${collectables.length} collectable(s) collectable.` +
      (warnings.length > 0
        ? ` Warnings (unreachable side areas — fine if decorative):\n` +
          warnings.map((w) => `• ${w}`).join("\n")
        : ""),
  };
}
