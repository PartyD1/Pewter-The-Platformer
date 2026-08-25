import { describe, expect, it } from "vitest";
import { JUMP_TIERS, latitudeForGap, solveJump } from "../jumpSolver";
import {
  classifyJump,
  DEFAULT_DIFFICULTY,
  DIFFICULTY_TIER,
  gapLadder,
  getLevelDifficulty,
  impossibleGapTiles,
  isBeyondHumanCeiling,
  LEVEL_DIFFICULTIES,
  maxGapForRunway,
  movementFacts,
  movementFactsFor,
  RUNWAY_RUNGS,
  runwayNeededForGap,
  setLevelDifficulty,
} from "../movementCapabilities";

describe("gap ladder", () => {
  it("is monotonic in runway for every tier", () => {
    for (const tier of JUMP_TIERS) {
      const gaps = gapLadder(tier).map((r) => r.gapTiles);
      for (let i = 1; i < gaps.length; i++) {
        expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
      }
    }
  });

  it("is monotonic in tier for every runway", () => {
    for (const runway of RUNWAY_RUNGS) {
      let prev = -1;
      for (const tier of JUMP_TIERS) {
        const gap = maxGapForRunway(runway, tier);
        expect(gap).toBeGreaterThanOrEqual(prev);
        prev = gap;
      }
    }
  });

  it("every rung really is clearable at its tier", () => {
    // The rung is a whole-tile floor of a solved bound, so the exact gap must
    // still leave at least that tier's timing slack.
    for (const tier of JUMP_TIERS) {
      for (const rung of gapLadder(tier)) {
        if (rung.gapTiles === 0) continue;
        const ms = latitudeForGap(
          { runwayTiles: rung.runwayTiles, deltaYTiles: 0 },
          rung.gapTiles,
        );
        expect(
          ms,
          `${tier} runway=${rung.runwayTiles} gap=${rung.gapTiles}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("an easier tier never demands more runway than a harder one", () => {
    for (let gap = 1; gap <= 10; gap++) {
      const easy = runwayNeededForGap(gap, "GUARANTEED");
      const hard = runwayNeededForGap(gap, "ULTRA");
      if (easy !== null && hard !== null) {
        expect(easy).toBeGreaterThanOrEqual(hard);
      }
      if (hard === null) expect(easy).toBeNull();
    }
  });
});

describe("impossibility bounds", () => {
  it("the impossible gap is beyond even the best-case maximum", () => {
    const spec = solveJump({
      runwayTiles: RUNWAY_RUNGS[RUNWAY_RUNGS.length - 1],
      deltaYTiles: 0,
    });
    expect(impossibleGapTiles()).toBeGreaterThan(spec.bestCaseUltraTiles);
  });

  it("no tier's ladder ever reaches the impossible width", () => {
    const impossible = impossibleGapTiles();
    for (const tier of JUMP_TIERS) {
      for (const rung of gapLadder(tier)) {
        expect(rung.gapTiles).toBeLessThan(impossible);
      }
    }
  });

  it("walls at the impossible height cannot be climbed at any tier", () => {
    const facts = movementFacts("ULTRA");
    expect(facts.impossibleWallTiles).toBeGreaterThan(facts.expertStepUpTiles);
    for (const tier of JUMP_TIERS) {
      expect(movementFacts(tier).maxStepUpTiles).toBeLessThan(
        facts.impossibleWallTiles,
      );
    }
  });
});

describe("difficulty dial", () => {
  it("harder difficulties never permit less than easier ones", () => {
    let prev = -1;
    for (const d of LEVEL_DIFFICULTIES) {
      const facts = movementFactsFor(d);
      expect(facts.maxGapTiles).toBeGreaterThanOrEqual(prev);
      prev = facts.maxGapTiles;
    }
  });

  it("only BRUTAL reaches past the honest human ceiling", () => {
    for (const d of LEVEL_DIFFICULTIES) {
      expect(isBeyondHumanCeiling(d)).toBe(d === "BRUTAL");
    }
    expect(DIFFICULTY_TIER.HARD).toBe("EXPERT");
    expect(DIFFICULTY_TIER.BRUTAL).toBe("ULTRA");
  });

  it("the current difficulty is settable and defaults sanely", () => {
    expect(getLevelDifficulty()).toBe(DEFAULT_DIFFICULTY);
    setLevelDifficulty("HARD");
    expect(getLevelDifficulty()).toBe("HARD");
    setLevelDifficulty(DEFAULT_DIFFICULTY);
  });
});

describe("classifyJump rates real geometry", () => {
  it("a short gap off a long runway is trivially easy", () => {
    expect(classifyJump(7, 3, 0)).toBe("GUARANTEED");
  });

  it("a gap past the physical limit is impossible", () => {
    expect(classifyJump(7, impossibleGapTiles() + 2, 0)).toBe("IMPOSSIBLE");
  });

  it("difficulty rises as the gap approaches the limit", () => {
    const easy = latitudeForGap({ runwayTiles: 4, deltaYTiles: 0 }, 5);
    const hard = latitudeForGap({ runwayTiles: 4, deltaYTiles: 0 }, 12);
    expect(easy).toBeGreaterThan(hard);
  });

  it("starving the runway makes the same gap harder", () => {
    const roomy = latitudeForGap({ runwayTiles: 7, deltaYTiles: 0 }, 9);
    const tight = latitudeForGap({ runwayTiles: 1, deltaYTiles: 0 }, 9);
    expect(roomy).toBeGreaterThan(tight);
  });
});

describe("facts sheet", () => {
  it("reports a sub-tile body that falls through 1-tile holes", () => {
    const f = movementFacts("NORMAL");
    expect(f.playerSizeTiles.width).toBeLessThan(1);
    expect(f.playerSizeTiles.height).toBeLessThan(1);
    expect(f.fallsThroughOneTileGap).toBe(true);
  });

  it("standing and max gaps match the ladder ends", () => {
    for (const tier of JUMP_TIERS) {
      const f = movementFacts(tier);
      const ladder = gapLadder(tier);
      expect(f.standingGapTiles).toBe(ladder[0].gapTiles);
      expect(f.maxGapTiles).toBe(ladder[ladder.length - 1].gapTiles);
    }
  });
});
