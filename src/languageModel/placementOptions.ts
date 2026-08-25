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

/** An inclusive rectangle of tiles, in the same shape clearTile takes. */
export interface ClearRect {
  fromX: number;
  toX: number;
  fromY: number;
  toY: number;
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
  /**
   * Solid tiles that must be REMOVED before this jump exists. On a map with
   * continuous ground, "the furthest jump" is mostly a pit that has not been
   * dug yet — leave these tiles in place and the player simply walks across.
   * Empty when the gap is already open air.
   */
  clearTheseTilesFirst: ClearRect[];
  /**
   * False when every block cell of the platform is already solid in the map
   * (e.g. landing on existing ground across a dug pit) — placing is a no-op.
   */
  needsBlockPlacement: boolean;
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
  /**
   * Live-map solidity test. When given, options are checked against the
   * real terrain: anything standing where the gap or the landing cell must
   * be open becomes a `clearTheseTilesFirst` rect (dropped instead if the
   * box forbids clearing it), and `needsBlockPlacement` reports whether the
   * platform blocks already exist. Omitted in pure-math contexts.
   */
  isSolid?: (x: number, y: number) => boolean;
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
/** Tight bounding rect of the solid cells inside a region, or null if none. */
function tightSolidRect(
  isSolid: (x: number, y: number) => boolean,
  fromX: number,
  toX: number,
  fromY: number,
  toY: number,
): ClearRect | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let x = fromX; x <= toX; x++) {
    for (let y = fromY; y <= toY; y++) {
      if (!isSolid(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { fromX: minX, toX: maxX, fromY: minY, toY: maxY };
}

function rectInBox(
  r: ClearRect,
  inBox: (x: number, y: number) => boolean,
): boolean {
  for (let x = r.fromX; x <= r.toX; x++) {
    for (let y = r.fromY; y <= r.toY; y++) {
      if (!inBox(x, y)) return false;
    }
  }
  return true;
}

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

    // Terrain pass: the solver modelled two platforms and open air between
    // them. Anything solid where that air must be is a tile to dig out —
    // and if the selection box forbids digging it, the option is
    // unbuildable and must not be offered at all.
    const clearRects: ClearRect[] = [];
    let needsBlockPlacement = true;
    if (b.isSolid) {
      // The corridor spans from the higher of the two surfaces down. The
      // gap is dug to the bottom of the map: a shallow pit is either a
      // walkway (too shallow) or a softlock (deep enough to trap, not
      // deep enough to respawn), and neither is a jump.
      const corridorTop = Math.min(landY, b.takeoff.y);
      const pitBottom = (b.mapHeight ?? b.takeoff.y + 9) - 1;
      const gapNear = b.takeoff.x + b.dir;
      const gapFar = landX - b.dir;
      const gapRect = tightSolidRect(
        b.isSolid,
        Math.min(gapNear, gapFar),
        Math.max(gapNear, gapFar),
        corridorTop,
        pitBottom,
      );
      // Landing columns only need opening down to the landing cell — the
      // rows below it are the platform the player stands on.
      const landRect = tightSolidRect(
        b.isSolid,
        fromX,
        toX,
        corridorTop,
        landY,
      );

      let buildable = true;
      for (const r of [gapRect, landRect]) {
        if (!r) continue;
        if (b.inBox && !rectInBox(r, b.inBox)) {
          buildable = false;
          break;
        }
        clearRects.push(r);
      }
      if (!buildable) continue;

      let allBlocksExist = true;
      for (let x = fromX; x <= toX; x++) {
        if (!b.isSolid(x, blockY)) allBlocksExist = false;
      }
      needsBlockPlacement = !allBlocksExist;
    }

    out.push({
      id: `rise${t.deltaYTiles >= 0 ? "+" : ""}${t.deltaYTiles}_gap${t.gapTiles}`,
      playerLandsOn: { x: landX, y: landY },
      placeSolidBlocksAt: { fromX, toX, y: blockY },
      gapTiles: t.gapTiles,
      risesTiles: t.deltaYTiles,
      timingSlackMs: t.timingSlackMs,
      clearTheseTilesFirst: clearRects,
      needsBlockPlacement,
    });
  }
  return out;
}
