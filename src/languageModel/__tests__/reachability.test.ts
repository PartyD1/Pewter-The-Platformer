import { describe, expect, it } from "vitest";
import {
  computeReachability,
  isCollectableReachable,
  type TileGridView,
} from "../reachability";
import {
  impossibleGapTiles,
  maxGapForRunway,
  movementFacts,
} from "../../phaser/movementCapabilities";

/**
 * Pinned to one tier so these tests do not depend on the editor's current
 * difficulty setting, and every bound is derived from the solver rather than
 * hardcoded. The tile counts moved once already when the solver replaced the
 * old closed-form estimate, and they will move again whenever the physics is
 * retuned — a test that hardcodes them is testing the wrong thing.
 */
const TIER = "GUARANTEED" as const;

/** Build a grid from ASCII art: '#' = solid, anything else = empty. */
function grid(rows: string[]): TileGridView {
  return {
    width: rows[0].length,
    height: rows.length,
    isSolid: (x, y) =>
      y >= 0 &&
      y < rows.length &&
      x >= 0 &&
      x < rows[0].length &&
      rows[y][x] === "#",
  };
}

const has = (r: ReturnType<typeof computeReachability>, x: number, y: number) =>
  r.reachable.has(`${x},${y}`);

/**
 * Floor with `runwayTiles` of standable run-up, then a gap, then landing
 * ground. Returns the column of the first landable tile across the gap.
 */
function gapGrid(runwayTiles: number, gapTiles: number) {
  const leftWidth = runwayTiles + 1;
  const floor = "#".repeat(leftWidth) + ".".repeat(gapTiles) + "###";
  return {
    g: grid([".".repeat(floor.length), floor]),
    targetX: leftWidth + gapTiles,
  };
}

/** A wall `h` tiles tall on the left, with floor to stand on at the right. */
function climbGrid(h: number) {
  const rows = [".".repeat(4)];
  for (let i = 0; i < h; i++) rows.push("#...");
  rows.push("####");
  return grid(rows);
}

describe("walking and falling", () => {
  it("reaches everything on a flat floor", () => {
    const g = grid(["........", "########"]);
    const r = computeReachability(g, { x: 0, y: 0 }, TIER);
    expect(r.standableCount).toBe(8);
    expect(r.reachable.size).toBe(8);
    expect(r.diagnoses).toEqual([]);
  });

  it("falls off a ledge onto lower ground (one-way)", () => {
    const g = grid([".......", "##.....", "##.....", "#######"]);
    const r = computeReachability(g, { x: 0, y: 0 }, TIER);
    expect(has(r, 4, 2)).toBe(true); // lower floor reached by falling
  });
});

describe("gaps and runway", () => {
  it("crosses exactly the gap the ladder promises from a standstill", () => {
    const reach = maxGapForRunway(0, TIER);
    const { g, targetX } = gapGrid(0, reach);
    const r = computeReachability(g, { x: 0, y: 0 }, TIER);
    expect(has(r, targetX, 0)).toBe(true);
    expect(r.diagnoses).toEqual([]);
  });

  it("cannot cross one tile wider than the ladder promises, and says why", () => {
    const tooFar = maxGapForRunway(0, TIER) + 1;
    const { g, targetX } = gapGrid(0, tooFar);
    const r = computeReachability(g, { x: 0, y: 0 }, TIER);
    expect(has(r, targetX, 0)).toBe(false);
    expect(r.diagnoses.join(" ")).toMatch(/gap/);
  });

  it("run-up buys reach: a gap too wide standing is crossable with runway", () => {
    const standing = maxGapForRunway(0, TIER);
    const running = maxGapForRunway(7, TIER);
    expect(running).toBeGreaterThan(standing); // else the fixture is vacuous

    const withRunway = gapGrid(7, running);
    const r2 = computeReachability(withRunway.g, { x: 0, y: 0 }, TIER);
    expect(has(r2, withRunway.targetX, 0)).toBe(true);

    const noRunway = gapGrid(0, running);
    const r1 = computeReachability(noRunway.g, { x: 0, y: 0 }, TIER);
    expect(has(r1, noRunway.targetX, 0)).toBe(false);
  });

  it("the impossible gap stays impossible however long the runway", () => {
    const gap = impossibleGapTiles();
    const { g, targetX } = gapGrid(12, gap);
    const r = computeReachability(g, { x: 0, y: 0 }, TIER);
    expect(has(r, targetX, 0)).toBe(false);
    expect(r.diagnoses.join(" ")).toMatch(/absolute maximum/);
  });
});

describe("climbing", () => {
  it("climbs exactly as high as the tier allows, and no higher", () => {
    const h = movementFacts(TIER).maxStepUpTiles;

    const ok = computeReachability(climbGrid(h), { x: 2, y: h }, TIER);
    expect(has(ok, 0, 0)).toBe(true);

    const bad = computeReachability(climbGrid(h + 1), { x: 2, y: h + 1 }, TIER);
    expect(has(bad, 0, 0)).toBe(false);
    expect(bad.diagnoses.join(" ")).toMatch(/higher|climb/);
  });

  it("rising costs reach: the widest flat gap fails when the target is raised", () => {
    const gap = maxGapForRunway(4, TIER);

    const level = gapGrid(4, gap);
    const flat = computeReachability(level.g, { x: 0, y: 0 }, TIER);
    expect(has(flat, level.targetX, 0)).toBe(true);

    // Same runway and gap, but the landing ground sits 2 tiles higher.
    const leftWidth = 5;
    const width = leftWidth + gap + 3;
    const raised = grid([
      ".".repeat(width),
      ".".repeat(leftWidth + gap) + "###",
      ".".repeat(width),
      "#".repeat(leftWidth) + ".".repeat(width - leftWidth),
    ]);
    const r = computeReachability(raised, { x: 0, y: 2 }, TIER);
    expect(has(r, leftWidth + gap, 0)).toBe(false);
  });
});

describe("start position and collectables", () => {
  it("diagnoses a start with no ground beneath it", () => {
    const g = grid(["....", "...."]);
    const r = computeReachability(g, { x: 1, y: 0 }, TIER);
    expect(r.reachable.size).toBe(0);
    expect(r.diagnoses.join(" ")).toMatch(/start position/i);
  });

  it("collectable within a jump above the floor is reachable; one above apex is not", () => {
    const g = grid([
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "........",
      "########",
    ]);
    const r = computeReachability(g, { x: 0, y: 7 }, TIER);
    expect(isCollectableReachable(r, g, 4, 2, TIER)).toBe(true); // 5 above floor
    expect(isCollectableReachable(r, g, 4, 0, TIER)).toBe(false); // 7 above floor
  });
});
