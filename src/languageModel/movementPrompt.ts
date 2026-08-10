/**
 * Renders MOVEMENT_CAPABILITIES (derived from live physics constants in
 * playerPhysics.ts) into the prose Pewter reads in its system prompt.
 * Never hardcode movement numbers in prompt strings — generate them here so
 * physics retuning propagates to the AI automatically.
 */
import { MOVEMENT_CAPABILITIES as CAPS } from "../phaser/playerPhysics";

/** "up to 4 tiles from a standstill; up to 8 with ≥1 tile of run-up; …" */
function gapLadderText(): string {
  const parts: string[] = [];
  let prevGap = -1;
  for (const rung of CAPS.gapForRunway) {
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
  return (
    "MOVEMENT FACTS (derived from the live game physics — trust these numbers exactly): " +
    "The player character is smaller than 1 tile " +
    `(${CAPS.playerSizeTiles.width}×${CAPS.playerSizeTiles.height} tiles), fits through any 1-tile opening, ` +
    (CAPS.fallsThroughOneTileGap
      ? "and WILL fall through a 1-tile-wide hole in the floor — a 1-tile gap is a real hazard and a valid design element. "
      : "but cannot fall through a 1-tile-wide hole in the floor. ") +
    `Climbing: ledges up to ${CAPS.maxStepUpTiles} tiles high are reliably climbable in one jump; ` +
    `${CAPS.expertStepUpTiles} tiles is the absolute maximum and requires a frame-perfect full jump; ` +
    `walls ${CAPS.impossibleWallTiles} tiles or taller are IMPOSSIBLE to climb. ` +
    `Horizontal gaps (jumping between platforms at similar height): crossable ${gapLadderText()}. ` +
    "'Run-up' means flat, unobstructed tiles immediately before the jump edge. " +
    `Gaps ${CAPS.impossibleGapTiles} tiles or wider are IMPOSSIBLE — never require one to progress. ` +
    "Jumping toward a HIGHER platform shortens reach: subtract roughly 2 tiles of gap distance per tile of height gained. " +
    `After landing at speed the player needs about ${CAPS.stopDistanceTiles} tiles to stop — leave landing room before hazards unless the challenge is intentional.`
  );
}
