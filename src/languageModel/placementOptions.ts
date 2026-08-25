/**
 * Turning solver output into concrete, buildable platform placements.
 *
 * Deliberately free of any editor or LangChain import so it can be unit
 * tested on its own: the tool module reaches chatBox -> modelConnector,
 * which throws without a .env, and this clamping logic is the part most
 * likely to be subtly wrong.
 */
import type { ReachableTarget } from "../phaser/movementCapabilities.ts";

/**
 * Describe how demanding a jump is, in terms a person can feel.
 *
 * The raw millisecond figure means nothing to the model or the player;
 * "about 2 frames at 60fps" does.
 */
export function describeHardness(timingSlackMs: number): string {
  const frames = Math.max(1, Math.round((timingSlackMs / 1000) * 60));
  if (timingSlackMs >= 150) {
    return `forgiving — about ${frames} frames of slack at 60fps`;
  }
  if (timingSlackMs >= 66) {
    return `moderate — about ${frames} frames of slack at 60fps`;
  }
  if (timingSlackMs >= 32) {
    return `VERY HARD — only about ${frames} frames of slack at 60fps`;
  }
  return `frame-perfect — about ${frames} frame of slack at 60fps, near the physical limit`;
}

/** One placement, fully specified. Nothing here may be mixed with anything else. */
export interface PlacementOption {
  id: string;
  /** Cell the player will stand on after landing. */
  playerLandsOn: { x: number; y: number };
  /** Where the platform's solid blocks go — one row BELOW the landing cell. */
  placeSolidBlocksAt: { fromX: number; toX: number; y: number };
  gapTiles: number;
  risesTiles: number;
  timingSlackMs: number;
}

export interface PlacementBounds {
  /** Takeoff cell the player jumps from. */
  takeoff: { x: number; y: number };
  /** +1 for rightward jumps, -1 for leftward. */
  dir: 1 | -1;
  /** Width of the landing platform, in tiles. */
  width: number;
  mapWidth?: number;
  mapHeight?: number;
  /** Selection box test. Omitted when there is no active box. */
  inBox?: (x: number, y: number) => boolean;
}

/**
 * Turn solver output into concrete, buildable placements, dropping any that
 * fall outside the map or the selection box.
 *
 * Pure, so the clamping can be tested without a live EditorScene — this is
 * the part most likely to be subtly wrong, and an option the agent is
 * forbidden to build is worse than no option at all: it will build it and
 * get rejected, burning a round.
 */
export function buildPlacementOptions(
  frontier: readonly ReachableTarget[],
  b: PlacementBounds,
): PlacementOption[] {
  const out: PlacementOption[] = [];
  for (const t of frontier) {
    const landX = b.takeoff.x + b.dir * (t.gapTiles + 1);
    const landY = b.takeoff.y - t.deltaYTiles;
    const blockY = landY + 1;
    const fromX = b.dir === 1 ? landX : landX - (b.width - 1);
    const toX = fromX + b.width - 1;

    if (landY < 0) continue;
    if (b.mapHeight !== undefined && blockY >= b.mapHeight) continue;
    if (fromX < 0) continue;
    if (b.mapWidth !== undefined && toX >= b.mapWidth) continue;

    if (b.inBox) {
      let fits = true;
      for (let x = fromX; x <= toX && fits; x++) {
        if (!b.inBox(x, landY) || !b.inBox(x, blockY)) fits = false;
      }
      if (!fits) continue;
    }

    out.push({
      id: `rise${t.deltaYTiles >= 0 ? "+" : ""}${t.deltaYTiles}_gap${t.gapTiles}`,
      playerLandsOn: { x: landX, y: landY },
      placeSolidBlocksAt: { fromX, toX, y: blockY },
      gapTiles: t.gapTiles,
      risesTiles: t.deltaYTiles,
      timingSlackMs: t.timingSlackMs,
    });
  }
  return out;
}
