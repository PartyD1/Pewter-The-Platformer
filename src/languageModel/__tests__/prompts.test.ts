import { describe, expect, it } from "vitest";
import { currentFacts } from "../../phaser/movementCapabilities";
import { buildMovementPromptSection } from "../movementPrompt";
import { buildDesignPolicySection, DESIGN_POLICY } from "../designPolicy";
import { buildSystemPrompt } from "../systemPrompt";

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

/**
 * The tests above exercise the prompt *builders*. They passed for months
 * while nothing called those builders and Pewter never saw a movement fact.
 * These assert against the prompt the model actually receives, which is the
 * only claim that matters.
 */
describe("the system prompt Pewter actually receives", () => {
  const prompt = buildSystemPrompt();

  it("embeds the movement facts verbatim", () => {
    expect(prompt).toContain(buildMovementPromptSection());
  });

  it("embeds the design policy verbatim", () => {
    expect(prompt).toContain(buildDesignPolicySection());
  });

  it("carries the live derived numbers, not stale literals", () => {
    const CAPS = currentFacts();
    expect(prompt).toContain(`${CAPS.impossibleGapTiles} tiles or wider`);
    expect(prompt).toContain(`ledges up to ${CAPS.maxStepUpTiles} tiles`);
  });

  it("names every tool the model must call, by its registered name", () => {
    // These are the names bound to the LLM (tool.name), not the registry
    // keys in main.ts — getting that wrong is why the read-only set was
    // silently misclassifying calculateMaxGap as a world edit.
    for (const toolName of [
      "calculateMaxGap",
      "findFurthestPlacement",
      "checkTraversal",
      "verifyComplete",
    ]) {
      expect(prompt, `prompt must name ${toolName}`).toContain(toolName);
    }
  });

  it("treats limit requests as a demand for a genuinely hard jump", () => {
    // "as far as possible" used to be answered at the level's everyday
    // difficulty, which the player reported as "not hard whatsoever".
    expect(prompt).toMatch(/GENUINELY HARD/);
    expect(prompt).toMatch(/never 'balanced'/);
    expect(prompt).toMatch(/do not warn the player that it might be difficult/);
    expect(prompt).toContain("BRUTAL");
  });

  it("explains that a max-height jump cannot be made harder", () => {
    expect(prompt).toMatch(/limited by the climb itself/);
  });

  it("wires the dig-first build contract into the prompt", () => {
    // On a map with continuous ground, "the furthest jump" is mostly a pit
    // that has not been dug yet. The tool returns the digging as clearTile
    // calls inside 'buildIt'; the prompt must make skipping them unthinkable.
    expect(prompt).toContain("buildIt");
    expect(prompt).toMatch(/DIG THE GAP/);
    expect(prompt).toContain("afterBuilding");
  });

  it("makes Pewter teach the player the max-distance technique", () => {
    // A limit jump requires running off the edge and jumping on a coyote
    // frame. A player who does not know that will call the level broken.
    expect(prompt).toContain("playerTip");
    expect(prompt).toMatch(/running OFF the edge/);
  });

  it("tells the model not to estimate jump distances itself", () => {
    expect(prompt).toMatch(/[Nn]ever estimate a jump distance/);
  });

  it("tells the model analysis calls are cheap", () => {
    // Without this the 8-round budget actively discourages the check.
    expect(prompt).toMatch(/do not count against your effort budget/);
  });

  it("still carries the non-negotiable framing", () => {
    expect(prompt).toContain("ONLY make changes inside the selection box");
    expect(prompt).toContain("X increases to the right");
    expect(prompt).toContain("maximum of 8 rounds");
  });
});
