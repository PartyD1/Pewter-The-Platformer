import { describe, expect, it } from "vitest";
import { currentFacts } from "../../phaser/movementCapabilities";
import { buildMovementPromptSection } from "../movementPrompt";
import { buildDesignPolicySection, DESIGN_POLICY } from "../designPolicy";

describe("movement prompt section", () => {
  const CAPS = currentFacts();
  const text = buildMovementPromptSection();

  it("contains every derived capability number (no hardcoding drift)", () => {
    expect(text).toContain(
      `up to ${CAPS.standingGapTiles} tiles from a standstill`,
    );
    expect(text).toContain(`up to ${CAPS.maxGapTiles} tiles`);
    expect(text).toContain(
      `${CAPS.impossibleGapTiles} tiles or wider are IMPOSSIBLE`,
    );
    expect(text).toContain(`ledges up to ${CAPS.maxStepUpTiles} tiles`);
    expect(text).toContain(
      `${CAPS.expertStepUpTiles} tiles is the absolute physical maximum`,
    );
    expect(text).toContain(`walls ${CAPS.impossibleWallTiles} tiles or taller`);
    expect(text).toContain(`${CAPS.stopDistanceTiles} tiles to stop`);
  });

  it("states the 1-tile-gap hazard consistent with the body size", () => {
    expect(text).toContain(
      CAPS.fallsThroughOneTileGap
        ? "WILL fall through a 1-tile-wide hole"
        : "cannot fall through a 1-tile-wide hole",
    );
  });

  it("does not contain the old stale claims", () => {
    expect(text).not.toContain("approximately 6 tiles");
    expect(text).not.toContain("not traversable or fallable");
  });
});

describe("design policy section", () => {
  const text = buildDesignPolicySection();

  it("encodes the challenging-by-default gap and climb ranges", () => {
    const [gapLo, gapHi] = DESIGN_POLICY.defaultGapRangeTiles;
    const [stepLo, stepHi] = DESIGN_POLICY.defaultStepUpRangeTiles;
    expect(text).toContain(`${gapLo}–${gapHi}-tile gaps`);
    expect(text).toContain(`${stepLo}–${stepHi}-tile climbs`);
    expect(text).toContain("1–2-tile hop");
    expect(text).toContain("overrides this default");
  });
});
