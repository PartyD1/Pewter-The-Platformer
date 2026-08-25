import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { EditorScene } from "../../phaser/editorScene.ts";
import {
  gapForTier,
  type JumpSituation,
  latitudeForGap,
  solveJump,
  tierForGap,
} from "../../phaser/jumpSolver.ts";
import {
  DIFFICULTY_TIER,
  getLevelDifficulty,
  LEVEL_DIFFICULTIES,
  type LevelDifficulty,
} from "../../phaser/movementCapabilities.ts";
import { buildGridView } from "../sceneReachability.ts";

/**
 * Read the real geometry around a proposed jump out of the live map:
 * how much flat run-up the takeoff tile actually has, and how much headroom
 * the corridor leaves. Returns null if the map isn't loaded.
 */
function readGeometry(
  scene: EditorScene,
  takeoff: { x: number; y: number },
  target: { x: number; y: number },
): { runwayTiles: number; deltaYTiles: number; ceilingTiles?: number } | null {
  const grid = buildGridView(scene);
  if (!grid) return null;

  const dir = target.x >= takeoff.x ? 1 : -1;
  const standable = (x: number, y: number) =>
    x >= 0 &&
    x < grid.width &&
    y >= 0 &&
    y + 1 < grid.height &&
    !grid.isSolid(x, y) &&
    grid.isSolid(x, y + 1);

  // Flat run-up behind the takeoff tile, capped where it stops being flat.
  let runwayTiles = 0;
  while (
    runwayTiles < 12 &&
    standable(takeoff.x - dir * (runwayTiles + 1), takeoff.y)
  ) {
    runwayTiles++;
  }

  // Lowest ceiling over the runway and the gap — that corridor is what
  // actually limits the jump, not the headroom at the takeoff tile alone.
  let ceiling = Infinity;
  const from = Math.min(takeoff.x, target.x);
  const to = Math.max(takeoff.x, target.x);
  for (let x = from; x <= to; x++) {
    let h = 0;
    while (
      h < 16 &&
      takeoff.y - (h + 1) >= 0 &&
      !grid.isSolid(x, takeoff.y - (h + 1))
    ) {
      h++;
    }
    ceiling = Math.min(ceiling, h);
  }

  return {
    runwayTiles,
    deltaYTiles: takeoff.y - target.y, // + = target higher (smaller row)
    ceilingTiles:
      Number.isFinite(ceiling) && ceiling < 16 ? ceiling : undefined,
  };
}

function describe(
  situation: JumpSituation,
  difficulty: LevelDifficulty,
  source: "level geometry" | "the numbers you supplied",
) {
  const spec = solveJump(situation);
  const tier = DIFFICULTY_TIER[difficulty];
  const recommended = Math.floor(gapForTier(spec, tier));

  return {
    readFrom: source,
    runwayTiles: situation.runwayTiles,
    deltaYTiles: situation.deltaYTiles,
    ceilingTiles: situation.ceilingTiles ?? null,
    levelDifficulty: difficulty,
    requiredTier: tier,

    /** USE THIS as the gap width, in whole tiles. */
    recommendedGapTiles: recommended,

    spectrum: {
      GUARANTEED: {
        gapTiles: Math.floor(spec.guaranteedTiles),
        timingSlackMs: Math.round(spec.latitudeMs.GUARANTEED),
      },
      NORMAL: {
        gapTiles: Math.floor(spec.normalTiles),
        timingSlackMs: Math.round(spec.latitudeMs.NORMAL),
      },
      EXPERT: {
        gapTiles: Math.floor(spec.expertTiles),
        timingSlackMs: Math.round(spec.latitudeMs.EXPERT),
      },
      ULTRA: {
        gapTiles: Math.floor(spec.ultraTiles),
        timingSlackMs: Math.round(spec.latitudeMs.ULTRA),
        note: "Frame-perfect. Optional routes only — never on the critical path.",
      },
    },

    impossibleGapTiles: spec.impossibleTiles,
    note:
      `Gaps of ${spec.impossibleTiles} tiles or wider are impossible on any machine. ` +
      `A gap wider than ${recommended} exceeds what a ${difficulty} level may require.`,
  };
}

export class CalculateJumpGaps {
  sceneGetter: () => EditorScene;

  constructor(sceneGetter: () => EditorScene) {
    this.sceneGetter = sceneGetter;
  }

  static argsSchema = z.object({
    runwayTiles: z
      .number()
      .describe(
        "Flat, unobstructed tiles of run-up available before the jump edge.",
      ),
    deltaYTiles: z
      .number()
      .describe(
        "Elevation change to the target platform in tiles (negative = DROP DOWN, positive = JUMP UP).",
      ),
    takeoffTile: z
      .object({ x: z.number(), y: z.number() })
      .optional()
      .describe(
        "Optional: tile coords of the tile the player jumps FROM. If given together with targetTile, real run-up and ceilings are read from the live map and override runwayTiles/deltaYTiles.",
      ),
    targetTile: z
      .object({ x: z.number(), y: z.number() })
      .optional()
      .describe(
        "Optional: tile coords of the tile the player lands ON. Use with takeoffTile.",
      ),
    gapTiles: z
      .number()
      .optional()
      .describe(
        "Optional: a specific gap width you are considering. Returns how much timing slack it leaves and which difficulty tier it belongs to.",
      ),
    difficulty: z
      .enum(LEVEL_DIFFICULTIES)
      .optional()
      .describe(
        "Optional: difficulty to budget against. Defaults to the level's current difficulty.",
      ),
  });

  toolCall = tool(
    async (args: z.infer<typeof CalculateJumpGaps.argsSchema>) => {
      const difficulty = args.difficulty ?? getLevelDifficulty();

      let situation: JumpSituation = {
        runwayTiles: args.runwayTiles,
        deltaYTiles: args.deltaYTiles,
      };
      let source: "level geometry" | "the numbers you supplied" =
        "the numbers you supplied";

      // Geometry-aware mode: trust the map over the model's arithmetic.
      if (args.takeoffTile && args.targetTile) {
        try {
          const geo = readGeometry(
            this.sceneGetter(),
            args.takeoffTile,
            args.targetTile,
          );
          if (geo) {
            situation = geo;
            source = "level geometry";
          }
        } catch {
          // Fall back to the supplied numbers rather than failing the call.
        }
      }

      const result = describe(situation, difficulty, source);

      // If they named a specific gap, grade that gap too.
      let proposed;
      if (args.gapTiles !== undefined) {
        const tier = tierForGap(situation, args.gapTiles);
        const slackMs = Math.round(latitudeForGap(situation, args.gapTiles));
        const allowed =
          tier !== "IMPOSSIBLE" && args.gapTiles <= result.recommendedGapTiles;
        proposed = {
          gapTiles: args.gapTiles,
          tier,
          timingSlackMs: slackMs,
          allowedAtThisDifficulty: allowed,
          verdict:
            tier === "IMPOSSIBLE"
              ? "IMPOSSIBLE — the player can never cross this. Narrow it."
              : allowed
                ? `OK. The player gets ${slackMs}ms of timing slack.`
                : `TOO HARD for a ${difficulty} level — only ${slackMs}ms of timing slack. Narrow it to ${result.recommendedGapTiles} tiles or raise the level difficulty.`,
        };
      }

      console.log(
        `[calculateMaxGap] runway=${situation.runwayTiles} deltaY=${situation.deltaYTiles} -> recommended ${result.recommendedGapTiles} (${difficulty})`,
      );

      return JSON.stringify(proposed ? { ...result, proposed } : result);
    },
    {
      name: "calculateMaxGap",
      schema: CalculateJumpGaps.argsSchema,
      description:
        "Compute exactly how far the player can jump, by simulating the real game physics frame by frame at 30/60/144fps. " +
        "Returns a difficulty spectrum rather than a single number: each tier gives the widest gap plus how many milliseconds of timing slack the player gets on the jump press. " +
        "Set your gap to 'recommendedGapTiles' — that is the widest gap this level's difficulty may require. " +
        "Pass takeoffTile and targetTile to have real run-up and ceilings read from the live map instead of trusting your own arithmetic. " +
        "Pass gapTiles to grade a specific gap you are considering. " +
        "Call this before committing to any jump; never guess gap sizes.",
    },
  );
}
