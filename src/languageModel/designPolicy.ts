/**
 * Default level-design difficulty policy for Pewter. Separate from physics
 * (movementPrompt.ts) so difficulty is tunable without touching movement.
 * Decision (Parth, 2026-08-10): default to challenging-but-fair — levels
 * built around 4–6-tile jumps, not trivial 1-block hops — unless the player
 * explicitly asks for something easier.
 */
import { currentFacts } from "../phaser/movementCapabilities";

export const DESIGN_POLICY = {
  /** Bread-and-butter mandatory jump gaps (tiles). */
  defaultGapRangeTiles: [4, 6] as const,
  /** Bread-and-butter mandatory climbs (tiles). */
  defaultStepUpRangeTiles: [3, 5] as const,
  /** No unchallenged flat walking longer than this (tiles). */
  maxFlatRunTiles: 8,
} as const;

export function buildDesignPolicySection(): string {
  const CAPS = currentFacts();
  const [gapLo, gapHi] = DESIGN_POLICY.defaultGapRangeTiles;
  const [stepLo, stepHi] = DESIGN_POLICY.defaultStepUpRangeTiles;
  return (
    "DESIGN DIFFICULTY (default: challenging but fair): Unless the player asks for an easy or kid-friendly level, " +
    "design near the limits of the movement facts above. " +
    `Mandatory jumps should mostly be ${gapLo}–${gapHi}-tile gaps and ${stepLo}–${stepHi}-tile climbs. ` +
    "Never build a challenge around a 1–2-tile hop — use those only to connect sections, and sparingly. " +
    `Avoid flat safe stretches longer than about ${DESIGN_POLICY.maxFlatRunTiles} tiles; break them up with a gap, height change, enemy, or hazard. ` +
    "Combine mechanics (a gap right after a climb, a coin suspended over a pit, a landing zone patrolled by an enemy) rather than repeating one jump. " +
    `Reserve maximum-skill moves (${CAPS.expertStepUpTiles}-tile climbs, ${CAPS.maxGapTiles}-tile gaps) for levels the player asked to be hard. ` +
    "NEVER exceed the movement facts — a level that cannot be finished is a failure, and verifyComplete will reject it. " +
    "If the player names a difficulty ('make it easy', 'brutal'), that overrides this default."
  );
}
