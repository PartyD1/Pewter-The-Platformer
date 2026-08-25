import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { EditorScene } from "../../phaser/editorScene.ts";
import {
  DIFFICULTY_TIER,
  LEVEL_DIFFICULTIES,
  type LevelDifficulty,
  reachableFrontier,
} from "../../phaser/movementCapabilities.ts";
import {
  buildPlacementOptions,
  describeHardness,
} from "../placementOptions.ts";
import { getProcessingBox } from "../chatBox.ts";
import { buildGridView } from "../sceneReachability.ts";

/**
 * Answers "put a platform as far / as high as possible while keeping it
 * reachable" in a single call.
 *
 * `calculateMaxGap` can only score a jump the caller has already picked,
 * which turns this request into a guess-and-check search across two
 * dimensions — and the agent has an 8-round budget.
 *
 * Hard-won shape notes, from watching a real transcript go wrong:
 *
 * 1. The reply used to be a flat `frontier` array of `{targetTile, ...}`.
 *    The model took the X from the furthest entry and the Y from a
 *    different one, producing a 13-tile gap at level height where 10 was
 *    the maximum — a placement no entry had endorsed. Options are now
 *    self-contained and labelled, and the rules say so explicitly.
 * 2. `targetTile` was ambiguous. It names the cell the PLAYER occupies, but
 *    the model read it as where to put blocks, shifting everything a tile.
 *    Both coordinates are now spelled out separately and named for what
 *    they are.
 * 3. Nothing was clamped, so options fell outside the map and outside the
 *    selection box the agent is forbidden to leave.
 */

/**
 * Difficulty an at-the-limit request is answered at, unless overridden.
 *
 * HARD maps to the EXPERT tier: ~32ms of timing slack, about two frames at
 * 60fps. That is the hardest jump a human can be asked to land reliably.
 * BRUTAL (ULTRA) is available on request but is frame-perfect AND depends
 * on a sub-pixel takeoff phase the player cannot see, so it is not a
 * sensible default even for "as far as possible".
 */
const LIMIT_DIFFICULTY: LevelDifficulty = "HARD";

export class FindFurthestPlacement {
  sceneGetter: () => EditorScene;

  constructor(sceneGetter: () => EditorScene) {
    this.sceneGetter = sceneGetter;
  }

  static argsSchema = z.object({
    takeoffTile: z
      .object({ x: z.number(), y: z.number() })
      .describe(
        "Tile coords of the cell the player JUMPS FROM — the empty cell they stand on at the platform's edge, not the solid block beneath it.",
      ),
    platformWidthTiles: z
      .number()
      .optional()
      .describe(
        "How many tiles wide the landing platform will be. Defaults to 3. Options are only returned if the whole platform fits.",
      ),
    intent: z
      .enum(["highest", "furthest", "balanced"])
      .describe(
        "REQUIRED. What the player actually asked for: 'furthest' = as far across as possible, 'highest' = as high up as possible, 'balanced' = a deliberate compromise. " +
          "Only pass 'balanced' if the player did NOT ask for an extreme — it returns a mid-range placement, which will feel easy.",
      ),
    direction: z
      .enum(["right", "left"])
      .optional()
      .describe("Which way the player jumps. Defaults to right."),
    difficulty: z
      .enum(LEVEL_DIFFICULTIES)
      .optional()
      .describe(
        "Override the difficulty. Leave this out for at-the-limit requests — the default is already HARD. Pass 'BRUTAL' only if the player explicitly wants a frame-perfect, near-impossible jump.",
      ),
  });

  toolCall = tool(
    async (args: z.infer<typeof FindFurthestPlacement.argsSchema>) => {
      // This tool exists ONLY to answer "put it at the limit". Budgeting
      // that against the level's everyday difficulty produced jumps the
      // player described as "not hard whatsoever" — NORMAL leaves ~66ms of
      // slack, which is comfortable. An at-the-limit request is a request
      // for a hard jump, so default to the hardest tier a human can
      // actually be asked to hit, and let `difficulty` override downward
      // (or up to BRUTAL) when the player says otherwise.
      const difficulty = args.difficulty ?? LIMIT_DIFFICULTY;
      const tier = DIFFICULTY_TIER[difficulty];
      const dir = args.direction === "left" ? -1 : 1;
      const width = Math.max(1, Math.round(args.platformWidthTiles ?? 3));
      const { x: tx, y: ty } = args.takeoffTile;
      const scene = this.sceneGetter();
      const grid = buildGridView(scene);
      const box = getProcessingBox() ?? scene.activeBox;

      // Measure the real run-up from the live map.
      let runwayTiles = 0;
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

      const options = buildPlacementOptions(
        reachableFrontier(runwayTiles, tier),
        {
          takeoff: { x: tx, y: ty },
          dir,
          width,
          mapWidth: grid?.width,
          mapHeight: grid?.height,
          inBox: box ? (x, y) => box.containsPoint(x, y) : undefined,
        },
      );

      if (options.length === 0) {
        return JSON.stringify({
          takeoffTile: args.takeoffTile,
          runwayTiles,
          error:
            "No reachable placement fits inside the selection box and the map. " +
            "Either the selection box is too small, the takeoff platform has no run-up, or the platform is too wide. " +
            "Widen the selection box or reduce platformWidthTiles.",
        });
      }

      // Options are ordered highest-first.
      const highest = options[0];
      let furthest = options[0];
      for (const o of options) if (o.gapTiles > furthest.gapTiles) furthest = o;
      const balanced = options[Math.floor(options.length / 2)];

      const intent = args.intent;
      const recommended =
        intent === "highest"
          ? highest
          : intent === "furthest"
            ? furthest
            : balanced;

      console.log(
        `[findFurthestPlacement] takeoff=(${tx},${ty}) runway=${runwayTiles} width=${width} intent=${intent} difficulty=${difficulty} -> ${recommended.id} (${recommended.timingSlackMs}ms)`,
      );

      return JSON.stringify({
        takeoffTile: args.takeoffTile,
        direction: args.direction ?? "right",
        runwayTiles,
        platformWidthTiles: width,
        levelDifficulty: difficulty,
        requiredTier: tier,
        intent,
        recommended: {
          ...recommended,
          hardness: describeHardness(recommended.timingSlackMs),
        },
        options,
        rules: [
          "USE 'recommended' UNLESS YOU HAVE A REASON NOT TO. It already matches the requested intent.",
          "This is meant to be a HARD jump. Do not soften it, do not move the platform closer, and do not apologise for the difficulty — the player asked for the limit.",
          "Each option is a COMPLETE placement. Never take x from one option and y from another — that produces a jump no option endorsed and the player cannot make it.",
          "Call placeGridofTiles with placeSolidBlocksAt: fromX..toX at row y. Do NOT place blocks at playerLandsOn — that is the empty cell the player occupies, one row above the blocks.",
          "Do not move the platform further across or higher than the option you picked. These are limits, not suggestions.",
          "Rising costs reach: the highest option is never also the furthest.",
          "verifyComplete passing does NOT prove this jump works — the player may be able to reach the platform another way, e.g. by walking along the ground and hopping up. If you want the jump itself checked, call calculateMaxGap with takeoffTile and targetTile.",
        ],
      });
    },
    {
      name: "findFurthestPlacement",
      schema: FindFurthestPlacement.argsSchema,
      description:
        "Find where a platform can be placed so the player can still jump to it from a given takeoff point, at the limit of what is reachable. " +
        "Use this whenever the player asks for something 'as far as possible', 'as high as possible', 'at the very edge', or otherwise at the limit. " +
        "Returns complete, ready-to-build placements — the exact blocks to place and the cell the player will land on — computed by simulating the real game physics. " +
        "Every option is clamped to the map and the selection box, so anything it returns is safe to build. " +
        "Pass 'intent' to say what the player actually asked for, then build the 'recommended' option verbatim.",
    },
  );
}
