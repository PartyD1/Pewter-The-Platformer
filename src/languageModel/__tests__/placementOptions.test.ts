import { describe, expect, it } from "vitest";
import { buildPlacementOptions, describeHardness } from "../placementOptions";
import { DIFFICULTY_TIER } from "../../phaser/movementCapabilities";
import { TIER_LATITUDE_MS } from "../../phaser/jumpSolver";
import type { ReachableTarget } from "../../phaser/movementCapabilities";

const frontier: ReachableTarget[] = [
  { deltaYTiles: 6, gapTiles: 5, timingSlackMs: 63 },
  { deltaYTiles: 0, gapTiles: 10, timingSlackMs: 97 },
  { deltaYTiles: -8, gapTiles: 13, timingSlackMs: 67 },
];

const base = {
  takeoff: { x: 9, y: 12 },
  dir: 1 as const,
  width: 3,
  mapWidth: 40,
  mapHeight: 20,
};

describe("placement options", () => {
  it("puts the blocks one row BELOW the cell the player lands on", () => {
    // The original tool returned a single ambiguous `targetTile`; the model
    // read it as "where to put blocks" and shifted the whole platform up a
    // tile. Both coordinates are now explicit.
    const [highest] = buildPlacementOptions([frontier[0]], base);
    expect(highest.playerLandsOn.y).toBe(12 - 6);
    expect(highest.placeSolidBlocksAt.y).toBe(highest.playerLandsOn.y + 1);
  });

  it("lands the player gap+1 tiles along, and spans the platform width", () => {
    const [level] = buildPlacementOptions([frontier[1]], base);
    expect(level.playerLandsOn.x).toBe(9 + 10 + 1);
    expect(level.placeSolidBlocksAt.fromX).toBe(level.playerLandsOn.x);
    expect(level.placeSolidBlocksAt.toX).toBe(level.playerLandsOn.x + 2);
  });

  it("extends leftward platforms away from the takeoff, not into the gap", () => {
    const [level] = buildPlacementOptions([frontier[1]], {
      ...base,
      dir: -1,
      takeoff: { x: 30, y: 12 },
    });
    expect(level.playerLandsOn.x).toBe(30 - 11);
    expect(level.placeSolidBlocksAt.toX).toBe(level.playerLandsOn.x);
    expect(level.placeSolidBlocksAt.fromX).toBe(level.playerLandsOn.x - 2);
  });

  it("drops options whose blocks would fall off the bottom of the map", () => {
    // The real transcript offered a landing at y=20 on a 20-tall map.
    const opts = buildPlacementOptions(frontier, base);
    expect(opts.every((o) => o.placeSolidBlocksAt.y < base.mapHeight)).toBe(
      true,
    );
    expect(opts.some((o) => o.risesTiles === -8)).toBe(false);
  });

  it("drops options that run off the right edge of the map", () => {
    const opts = buildPlacementOptions(frontier, { ...base, mapWidth: 15 });
    expect(opts.every((o) => o.placeSolidBlocksAt.toX < 15)).toBe(true);
  });

  it("drops options outside the selection box, blocks and landing cell alike", () => {
    const inBox = (x: number, y: number) =>
      x >= 0 && x <= 21 && y >= 0 && y <= 19;
    const opts = buildPlacementOptions(frontier, { ...base, inBox });
    for (const o of opts) {
      expect(inBox(o.placeSolidBlocksAt.fromX, o.placeSolidBlocksAt.y)).toBe(
        true,
      );
      expect(inBox(o.placeSolidBlocksAt.toX, o.placeSolidBlocksAt.y)).toBe(
        true,
      );
      expect(inBox(o.playerLandsOn.x, o.playerLandsOn.y)).toBe(true);
    }
  });

  it("returns nothing rather than something unbuildable", () => {
    const opts = buildPlacementOptions(frontier, {
      ...base,
      inBox: () => false,
    });
    expect(opts).toEqual([]);
  });

  it("a wider platform can no longer fit where a narrow one did", () => {
    const inBox = (x: number, y: number) => x <= 22 && y >= 0 && y <= 19;
    const narrow = buildPlacementOptions([frontier[1]], {
      ...base,
      width: 1,
      inBox,
    });
    const wide = buildPlacementOptions([frontier[1]], {
      ...base,
      width: 5,
      inBox,
    });
    expect(narrow.length).toBe(1);
    expect(wide.length).toBe(0);
  });

  it("an at-the-limit request resolves to a genuinely hard tier", () => {
    // The player's complaint was that "furthest possible" produced jumps
    // that were "not hard whatsoever". findFurthestPlacement now defaults
    // to HARD rather than the level's everyday difficulty; HARD must stay
    // strictly harder than NORMAL or the complaint comes straight back.
    const limitTier = DIFFICULTY_TIER.HARD;
    expect(limitTier).toBe("EXPERT");
    expect(TIER_LATITUDE_MS[limitTier]).toBeLessThan(
      TIER_LATITUDE_MS[DIFFICULTY_TIER.NORMAL],
    );
    // ...but still not the frame-perfect tier, which is not humanly fair.
    expect(TIER_LATITUDE_MS[limitTier]).toBeGreaterThan(
      TIER_LATITUDE_MS[DIFFICULTY_TIER.BRUTAL],
    );
  });

  it("describes hardness in frames, and calls the limit tier VERY HARD", () => {
    expect(describeHardness(500)).toContain("forgiving");
    expect(describeHardness(100)).toContain("moderate");
    expect(describeHardness(TIER_LATITUDE_MS.EXPERT)).toContain("VERY HARD");
    expect(describeHardness(16)).toContain("frame-perfect");
    // The number a player can act on is frames, not milliseconds.
    expect(describeHardness(TIER_LATITUDE_MS.EXPERT)).toMatch(/2 frames/);
  });

  describe("terrain pass", () => {
    // A default-map-like world: continuous solid ground from row 13 down,
    // the player stands on row 12.
    const groundFrom13 = (_x: number, y: number) => y >= 13;

    it("a flat jump over continuous ground demands the pit be dug to the map bottom", () => {
      const [opt] = buildPlacementOptions([frontier[1]], {
        ...base,
        isSolid: groundFrom13,
      });
      // gap 10: columns 10..19 between takeoff x=9 and landing x=20.
      expect(opt.clearTheseTilesFirst).toEqual([
        { fromX: 10, toX: 19, fromY: 13, toY: 19 },
      ]);
      // The landing surface across the pit is the existing ground.
      expect(opt.needsBlockPlacement).toBe(false);
    });

    it("open sky needs no clearing and does need blocks", () => {
      const opts = buildPlacementOptions([frontier[0]], {
        ...base,
        isSolid: () => false,
      });
      expect(opts[0].clearTheseTilesFirst).toEqual([]);
      expect(opts[0].needsBlockPlacement).toBe(true);
    });

    it("drops an option whose pit the selection box does not allow digging", () => {
      const shallowBox = (_x: number, y: number) => y <= 14; // pit rows 13..19 not fully inside
      const opts = buildPlacementOptions([frontier[1]], {
        ...base,
        isSolid: groundFrom13,
        inBox: shallowBox,
      });
      expect(opts.length).toBe(0);

      const fullBox = (_x: number, _y: number) => true;
      const ok = buildPlacementOptions([frontier[1]], {
        ...base,
        isSolid: groundFrom13,
        inBox: fullBox,
      });
      expect(ok.length).toBe(1);
    });

    it("a drop into existing ground opens the landing shaft only down to the landing cell", () => {
      const drop: ReachableTarget = {
        deltaYTiles: -3,
        gapTiles: 12,
        timingSlackMs: 80,
      };
      const [opt] = buildPlacementOptions([drop], {
        ...base,
        isSolid: groundFrom13,
      });
      // landX = 22, landY = 15, blocks at 16 (already solid ground).
      expect(opt.playerLandsOn).toEqual({ x: 22, y: 15 });
      expect(opt.clearTheseTilesFirst).toEqual([
        { fromX: 10, toX: 21, fromY: 13, toY: 19 }, // the pit
        { fromX: 22, toX: 24, fromY: 13, toY: 15 }, // the landing shaft
      ]);
      expect(opt.needsBlockPlacement).toBe(false);
    });
  });

  it("gives every option a distinct, self-describing id", () => {
    const opts = buildPlacementOptions(frontier, base);
    const ids = opts.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toContain("rise+6");
  });
});
