import { describe, expect, it } from "vitest";
import { latitudeForGap } from "../jumpSolver";
import {
  furthestReachable,
  highestReachable,
  maxGapForRunway,
  maxGapForRunwayAtRise,
  movementFacts,
  reachableFrontier,
} from "../movementCapabilities";

const TIER = "NORMAL" as const;

describe("reachable frontier", () => {
  it("is ordered highest-first and strictly descending in elevation", () => {
    const f = reachableFrontier(4, TIER);
    expect(f.length).toBeGreaterThan(1);
    for (let i = 1; i < f.length; i++) {
      expect(f[i].deltaYTiles).toBeLessThan(f[i - 1].deltaYTiles);
    }
  });

  it("never lists an unreachable placement", () => {
    for (const t of reachableFrontier(4, TIER)) {
      expect(t.gapTiles).toBeGreaterThanOrEqual(1);
      expect(t.timingSlackMs).toBeGreaterThan(0);
    }
  });

  it("every listed placement really is landable at its own elevation", () => {
    for (const runway of [0, 2, 7]) {
      for (const t of reachableFrontier(runway, TIER)) {
        const ms = latitudeForGap(
          { runwayTiles: runway, deltaYTiles: t.deltaYTiles },
          t.gapTiles,
        );
        expect(
          ms,
          `runway=${runway} rise=${t.deltaYTiles} gap=${t.gapTiles}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("rising costs reach — the curve is a real trade-off, not a plateau", () => {
    // This is the whole reason the tool returns a frontier instead of one
    // "best" answer: you cannot be both highest and furthest.
    const f = reachableFrontier(7, TIER);
    const highest = f[0];
    const furthest = furthestReachable(7, TIER)!;
    expect(furthest.gapTiles).toBeGreaterThan(highest.gapTiles);
    expect(highest.deltaYTiles).toBeGreaterThan(furthest.deltaYTiles);
  });

  it("gap is non-increasing as the target rises", () => {
    const f = reachableFrontier(7, TIER);
    // Ordered highest-first, so gaps should never shrink as we descend.
    for (let i = 1; i < f.length; i++) {
      expect(f[i].gapTiles).toBeGreaterThanOrEqual(f[i - 1].gapTiles);
    }
  });

  it("agrees with the flat-ground ladder at zero elevation change", () => {
    for (const runway of [0, 1, 2, 4, 7]) {
      const level = reachableFrontier(runway, TIER).find(
        (t) => t.deltaYTiles === 0,
      );
      expect(level).toBeDefined();
      expect(level!.gapTiles).toBe(maxGapForRunway(runway, TIER));
    }
  });

  it("cannot climb higher than the tier's step-up allows", () => {
    const cap = movementFacts(TIER).maxStepUpTiles;
    expect(highestReachable(7, TIER)!.deltaYTiles).toBeLessThanOrEqual(cap);
  });

  it("more runway never yields a worse frontier", () => {
    const lo = furthestReachable(0, TIER)!;
    const hi = furthestReachable(7, TIER)!;
    expect(hi.gapTiles).toBeGreaterThanOrEqual(lo.gapTiles);
  });

  it("an easier tier is never more permissive than a harder one", () => {
    const easy = furthestReachable(4, "GUARANTEED")!;
    const hard = furthestReachable(4, "ULTRA")!;
    expect(easy.gapTiles).toBeLessThanOrEqual(hard.gapTiles);
  });
});

/**
 * The whole point of one engine is that the tool proposing a placement and
 * the checker validating it cannot disagree.
 *
 * They did. The reachability graph approximated rising jumps as "subtract 2
 * tiles of gap per tile of rise", so at 3 tiles of run-up it allowed a
 * 0-tile gap while rising 6 — against the solver's 6. Pewter would have
 * placed exactly what findFurthestPlacement recommended and had
 * verifyComplete reject it on the next round.
 */
describe("the frontier tool and the reachability graph agree", () => {
  it("on every rise, for every runway, at every tier", () => {
    for (const tier of ["GUARANTEED", "NORMAL", "EXPERT", "ULTRA"] as const) {
      for (const runway of [0, 2, 3, 7]) {
        for (const t of reachableFrontier(runway, tier)) {
          if (t.deltaYTiles < 0) continue; // drops use the flat bound
          expect(
            maxGapForRunwayAtRise(runway, t.deltaYTiles, tier),
            `tier=${tier} runway=${runway} rise=${t.deltaYTiles}`,
          ).toBe(t.gapTiles);
        }
      }
    }
  });

  it("matches the ladder on its own rungs, and is never below it between them", () => {
    // The ladder samples {0,1,2,4,7} for the prompt's benefit. On those
    // runways it must agree exactly; on runways in between it may be
    // strictly better, never worse — the ladder rounds down.
    for (const runway of [0, 1, 2, 4, 7]) {
      expect(maxGapForRunwayAtRise(runway, 0, "NORMAL")).toBe(
        maxGapForRunway(runway, "NORMAL"),
      );
    }
    for (const runway of [3, 5, 6]) {
      expect(maxGapForRunwayAtRise(runway, 0, "NORMAL")).toBeGreaterThanOrEqual(
        maxGapForRunway(runway, "NORMAL"),
      );
    }
  });
});
