import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { EditorScene } from "../../phaser/editorScene.ts";
import {
  DIFFICULTY_TIER,
  getLevelDifficulty,
  LEVEL_DIFFICULTIES,
  reachableFrontier,
} from "../../phaser/movementCapabilities.ts";
import { buildGridView } from "../sceneReachability.ts";

/**
 * Answers "put a platform as far / as high as possible while keeping it
 * reachable" in a single call.
 *
 * `calculateMaxGap` can only score a jump the caller has already picked,
 * which turns this request into a guess-and-check search across two
 * dimensions — and the agent has an 8-round budget. Rising and reaching
 * trade off against each other, so the honest answer is the whole frontier
 * plus the two extremes, in concrete tile coordinates the agent can place at
 * directly.
 */
export class FindFurthestPlacement {
  sceneGetter: () => EditorScene;

  constructor(sceneGetter: () => EditorScene) {
    this.sceneGetter = sceneGetter;
  }

  static argsSchema = z.object({
    takeoffTile: z
      .object({ x: z.number(), y: z.number() })
      .describe(
        "Tile coords of the tile the player jumps FROM — the standable tile at the edge of the takeoff platform (the empty tile the player stands on, not the solid block beneath).",
      ),
    direction: z
      .enum(["right", "left"])
      .optional()
      .describe("Which way the player jumps. Defaults to right."),
    runwayTiles: z
      .number()
      .optional()
      .describe(
        "Override the run-up. Normally omit this — the real run-up is measured from the live map.",
      ),
    difficulty: z
      .enum(LEVEL_DIFFICULTIES)
      .optional()
      .describe(
        "Difficulty to budget against. Defaults to the level's current difficulty.",
      ),
  });

  toolCall = tool(
    async (args: z.infer<typeof FindFurthestPlacement.argsSchema>) => {
      const difficulty = args.difficulty ?? getLevelDifficulty();
      const tier = DIFFICULTY_TIER[difficulty];
      const dir = args.direction === "left" ? -1 : 1;
      const { x: tx, y: ty } = args.takeoffTile;

      // Measure the real run-up unless explicitly overridden.
      let runwayTiles = args.runwayTiles ?? 0;
      if (args.runwayTiles === undefined) {
        const grid = buildGridView(this.sceneGetter());
        if (grid) {
          const standable = (x: number, y: number) =>
            x >= 0 &&
            x < grid.width &&
            y >= 0 &&
            y + 1 < grid.height &&
            !grid.isSolid(x, y) &&
            grid.isSolid(x, y + 1);
          while (
            runwayTiles < 12 &&
            standable(tx - dir * (runwayTiles + 1), ty)
          ) {
            runwayTiles++;
          }
        }
      }

      const frontier = reachableFrontier(runwayTiles, tier);
      if (frontier.length === 0) {
        return JSON.stringify({
          takeoffTile: args.takeoffTile,
          runwayTiles,
          error:
            "Nothing is reachable from this takeoff tile — it has no run-up and no landable target. Widen the takeoff platform.",
        });
      }

      // Concrete coordinates: a gap of N tiles lands N+1 tiles along.
      const place = (t: (typeof frontier)[number]) => ({
        targetTile: { x: tx + dir * (t.gapTiles + 1), y: ty - t.deltaYTiles },
        gapTiles: t.gapTiles,
        risesTiles: t.deltaYTiles,
        timingSlackMs: t.timingSlackMs,
      });

      const highest = frontier[0];
      let furthest = frontier[0];
      for (const t of frontier)
        if (t.gapTiles > furthest.gapTiles) furthest = t;

      console.log(
        `[findFurthestPlacement] takeoff=(${tx},${ty}) runway=${runwayTiles} -> highest +${highest.deltaYTiles} / furthest ${furthest.gapTiles}`,
      );

      return JSON.stringify({
        takeoffTile: args.takeoffTile,
        direction: args.direction ?? "right",
        runwayTiles,
        levelDifficulty: difficulty,
        requiredTier: tier,
        highest: place(highest),
        furthest: place(furthest),
        frontier: frontier.map(place),
        note:
          "Rising costs reach, so 'highest' and 'furthest' are usually different tiles — pick from 'frontier' if you want a compromise. " +
          "These positions are already the limit for this difficulty; do not push past them. " +
          "targetTile is where the landing platform's NEAR edge must go.",
      });
    },
    {
      name: "findFurthestPlacement",
      schema: FindFurthestPlacement.argsSchema,
      description:
        "Find the extreme positions a platform can be placed at while staying reachable, given where the player jumps from. " +
        "Use this whenever the player asks for something 'as far as possible', 'as high as possible', 'at the very edge', or otherwise at the limit of what is reachable. " +
        "Returns concrete target tile coordinates for the highest reachable spot, the furthest reachable spot, and the full trade-off curve between them — " +
        "computed by simulating the real game physics, so the answers are exact. " +
        "Prefer this over guessing a position and checking it with calculateMaxGap.",
    },
  );
}
