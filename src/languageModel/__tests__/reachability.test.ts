import { describe, expect, it } from "vitest";
import {
  computeReachability,
  isCollectableReachable,
  type TileGridView,
} from "../reachability";

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

describe("walking and falling", () => {
  it("reaches everything on a flat floor", () => {
    const g = grid(["........", "########"]);
    const r = computeReachability(g, { x: 0, y: 0 });
    expect(r.standableCount).toBe(8);
    expect(r.reachable.size).toBe(8);
    expect(r.diagnoses).toEqual([]);
  });

  it("falls off a ledge onto lower ground (one-way)", () => {
    const g = grid([".......", "##.....", "##.....", "#######"]);
    const r = computeReachability(g, { x: 0, y: 0 });
    expect(has(r, 4, 2)).toBe(true); // lower floor reached by falling
  });
});

describe("gaps and runway", () => {
  it("crosses a 4-tile gap from a standstill", () => {
    const g = grid(["......", "#....#"]);
    const r = computeReachability(g, { x: 0, y: 0 });
    expect(has(r, 5, 0)).toBe(true);
    expect(r.diagnoses).toEqual([]);
  });

  it("cannot cross a 5-tile gap from a standstill, and says why", () => {
    const g = grid([".......", "#.....#"]);
    const r = computeReachability(g, { x: 0, y: 0 });
    expect(has(r, 6, 0)).toBe(false);
    expect(r.diagnoses.join(" ")).toMatch(/gap/);
  });

  it("crosses a 9-tile gap with 2 tiles of run-up but not with 1", () => {
    const withRunway2 = grid(["...............", "###.........###"]);
    const r2 = computeReachability(withRunway2, { x: 0, y: 0 });
    expect(has(r2, 12, 0)).toBe(true);

    const withRunway1 = grid(["...............", ".##.........###"]);
    const r1 = computeReachability(withRunway1, { x: 1, y: 0 });
    expect(has(r1, 12, 0)).toBe(false);
  });

  it("a 12-tile gap is impossible regardless of runway", () => {
    const g = grid([
      "..........................",
      "#############............#",
    ]);
    const r = computeReachability(g, { x: 0, y: 0 });
    expect(has(r, 25, 0)).toBe(false);
    expect(r.diagnoses.join(" ")).toMatch(/absolute maximum/);
  });
});

describe("climbing", () => {
  it("climbs a 5-tile ledge but not a 6-tile one", () => {
    const climbable = grid([
      "....",
      "#...",
      "#...",
      "#...",
      "#...",
      "#...",
      "####",
    ]);
    const r = computeReachability(climbable, { x: 2, y: 5 });
    expect(has(r, 0, 0)).toBe(true);

    const tooTall = grid([
      "....",
      "#...",
      "#...",
      "#...",
      "#...",
      "#...",
      "#...",
      "####",
    ]);
    const r2 = computeReachability(tooTall, { x: 2, y: 6 });
    expect(has(r2, 0, 0)).toBe(false);
    expect(r2.diagnoses.join(" ")).toMatch(/higher|climb/);
  });

  it("rising jumps lose reach: 2-tile gap up 2 tiles fails from a standstill, passes with runway", () => {
    const noRunway = grid([
      "........",
      "........",
      ".......,",
      ".......#",
      "........",
      "....#...",
    ]);
    // Standing on the single tile at (4,4); target platform top at (7,2).
    const r = computeReachability(noRunway, { x: 4, y: 4 });
    expect(has(r, 7, 2)).toBe(false);

    const withRunway = grid([
      "........",
      "........",
      "........",
      ".......#",
      "........",
      "#####...",
    ]);
    const r2 = computeReachability(withRunway, { x: 0, y: 4 });
    expect(has(r2, 7, 2)).toBe(true);
  });
});

describe("start position and collectables", () => {
  it("diagnoses a start with no ground beneath it", () => {
    const g = grid(["....", "...."]);
    const r = computeReachability(g, { x: 1, y: 0 });
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
    const r = computeReachability(g, { x: 0, y: 7 });
    expect(isCollectableReachable(r, g, 4, 2)).toBe(true); // 5 above floor
    expect(isCollectableReachable(r, g, 4, 0)).toBe(false); // 7 above floor
  });
});
