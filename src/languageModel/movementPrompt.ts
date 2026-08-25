/**
 * Renders the movement facts (derived by the frame-accurate solver in
 * phaser/jumpSolver.ts) into the prose Pewter reads in its system prompt.
 * Never hardcode movement numbers in prompt strings — generate them here so
 * physics retuning propagates to the AI automatically.
 *
 * The numbers rendered depend on the level's difficulty: a HARD level is
 * told about tighter jumps than an EASY one, because the tier it is allowed
 * to require is what defines its budget.
 */
import {
  currentFacts,
  DIFFICULTY_TIER,
  getLevelDifficulty,
  isBeyondHumanCeiling,
  type MovementFacts,
} from "../phaser/movementCapabilities";

/** "up to 4 tiles from a standstill; up to 8 with ≥1 tile of run-up; …" */
function gapLadderText(facts: MovementFacts): string {
  const parts: string[] = [];
  let prevGap = -1;
  for (const rung of facts.gapForRunway) {
    if (rung.gapTiles === prevGap) continue; // skip redundant rungs
    parts.push(
      rung.runwayTiles === 0
        ? `up to ${rung.gapTiles} tiles from a standstill`
        : `up to ${rung.gapTiles} tiles with at least ${rung.runwayTiles} tile${rung.runwayTiles === 1 ? "" : "s"} of run-up`,
    );
    prevGap = rung.gapTiles;
  }
  return parts.join("; ");
}

export function buildMovementPromptSection(): string {
  const facts = currentFacts();
  const difficulty = getLevelDifficulty();
  const tier = DIFFICULTY_TIER[difficulty];

  return (
    "MOVEMENT FACTS (derived by simulating the live game physics frame by frame — trust these numbers exactly): " +
    "The player character is smaller than 1 tile " +
    `(${facts.playerSizeTiles.width}×${facts.playerSizeTiles.height} tiles), fits through any 1-tile opening, ` +
    (facts.fallsThroughOneTileGap
      ? "and WILL fall through a 1-tile-wide hole in the floor — a 1-tile gap is a real hazard and a valid design element. "
      : "but cannot fall through a 1-tile-wide hole in the floor. ") +
    `This level's difficulty is ${difficulty}, so every jump you REQUIRE must be clearable at the ${tier} tier. ` +
    "The numbers below are already the limits for that tier — they are not estimates, and they hold at every frame rate. " +
    `Climbing: ledges up to ${facts.maxStepUpTiles} tiles high are climbable at this difficulty; ` +
    `${facts.expertStepUpTiles} tiles is the absolute physical maximum and requires a frame-perfect jump; ` +
    `walls ${facts.impossibleWallTiles} tiles or taller are IMPOSSIBLE to climb. ` +
    `Horizontal gaps (jumping between platforms at similar height): crossable ${gapLadderText(facts)}. ` +
    "'Run-up' means flat, unobstructed tiles immediately before the jump edge. " +
    `Gaps ${facts.impossibleGapTiles} tiles or wider are IMPOSSIBLE on any machine — never require one to progress. ` +
    "Jumping toward a HIGHER platform shortens reach; call calculateMaxGap for the exact number instead of guessing. " +
    `After landing at speed the player needs about ${facts.stopDistanceTiles} tiles to stop — leave landing room before hazards unless the challenge is intentional. ` +
    (isBeyondHumanCeiling(difficulty)
      ? "WARNING: this difficulty permits frame-perfect jumps. Use them only on optional routes (secrets, bonus collectables) — never on the path the player must take to finish the level. "
      : "") +
    "A jump at the very edge of these limits is a HARD jump, not a normal one: the player gets only a few hundredths of a second of timing slack. " +
    "Use calculateMaxGap to check how much timing slack a specific jump leaves before you commit to it."
  );
}
