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
import { snapToStandable } from "../reachability.ts";

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
      const tx = args.takeoffTile.x;
      let ty = args.takeoffTile.y;
      const scene = this.sceneGetter();
      const grid = buildGridView(scene);
      const box = getProcessingBox() ?? scene.activeBox;

      // The model routinely passes the solid block instead of the cell the
      // player stands on, or a cell floating in the sky. Both are silently
      // off by tiles — snap to the real standable cell in that column and
      // say so, instead of computing an answer for a takeoff nobody is at.
      let takeoffAdjusted: string | undefined;
      if (grid) {
        const snapped = snapToStandable(grid, tx, ty);
        if (!snapped) {
          return JSON.stringify({
            takeoffTile: args.takeoffTile,
            error:
              `takeoffTile (${tx}, ${ty}) has no standable cell in its column — there is no ground the player could jump from there. ` +
              "Pass the empty cell the player stands on at the edge of a real platform.",
          });
        }
        if (snapped.y !== ty) {
          takeoffAdjusted = `takeoffTile was adjusted from (${tx}, ${ty}) to (${tx}, ${snapped.y}) — the given cell was ${ty > snapped.y ? "inside the ground" : "floating in the air"}. All results below use the adjusted cell.`;
          ty = snapped.y;
        }
      }

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

      // Lowest real ceiling over the corridor the jump flies through —
      // runway plus the widest gap the ladder could propose. The solver's
      // apex is ~7 tiles above the takeoff, so anything at 8+ (including
      // the open map top) cannot constrain the jump and counts as sky.
      const CEILING_CAP = 8;
      let ceilingTiles: number | undefined;
      if (grid) {
        let ceiling = CEILING_CAP;
        const span = runwayTiles + 16;
        for (let i = -runwayTiles; i <= span - runwayTiles; i++) {
          const x = tx + dir * i;
          if (x < 0 || x >= grid.width) continue;
          let h = 0;
          while (h < CEILING_CAP) {
            const yy = ty - (h + 1);
            if (yy < 0) {
              h = CEILING_CAP; // limited only by the map top = open sky
              break;
            }
            if (grid.isSolid(x, yy)) break;
            h++;
          }
          if (h < ceiling) ceiling = h;
        }
        if (ceiling < CEILING_CAP) ceilingTiles = ceiling;
      }

      const options = buildPlacementOptions(
        reachableFrontier(runwayTiles, tier, ceilingTiles),
        {
          takeoff: { x: tx, y: ty },
          dir,
          width,
          mapWidth: grid?.width,
          mapHeight: grid?.height,
          inBox: box ? (x, y) => box.containsPoint(x, y) : undefined,
          isSolid: grid ? (x, y) => grid.isSolid(x, y) : undefined,
        },
      );

      if (options.length === 0) {
        return JSON.stringify({
          takeoffTile: { x: tx, y: ty },
          takeoffAdjusted,
          runwayTiles,
          ceilingTiles: ceilingTiles ?? null,
          error:
            "No reachable placement fits inside the selection box and the map. " +
            "Either the selection box is too small (it must also contain the full depth of any gap that needs digging out), " +
            "the takeoff platform has no run-up, a low ceiling blocks the jump, or the platform is too wide. " +
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
        `[findFurthestPlacement] takeoff=(${tx},${ty}) runway=${runwayTiles} ceiling=${ceilingTiles ?? "sky"} width=${width} intent=${intent} difficulty=${difficulty} -> ${recommended.id} (${recommended.timingSlackMs}ms, ${recommended.clearTheseTilesFirst.length} clear rect(s))`,
      );

      // Ready-to-fire tool calls for the recommended option, in order.
      // Every other option carries the same fields; the rules explain the
      // identical mapping.
      const buildIt = [
        ...recommended.clearTheseTilesFirst.map((r) => ({
          tool: "clearTile",
          args: {
            xMin: r.fromX,
            xMax: r.toX,
            yMin: r.fromY,
            yMax: r.toY,
            layerName: "Ground_Layer",
          },
          why: "digs out the gap — leave these tiles in place and the player simply walks across instead of jumping",
        })),
        ...(recommended.needsBlockPlacement
          ? [
              {
                tool: "placeGridofTiles",
                args: {
                  tileIndex: 4,
                  xMin: recommended.placeSolidBlocksAt.fromX,
                  xMax: recommended.placeSolidBlocksAt.toX,
                  yMin: recommended.placeSolidBlocksAt.y,
                  yMax: recommended.placeSolidBlocksAt.y,
                  layerName: "Ground_Layer",
                },
                why: "the landing platform",
              },
            ]
          : []),
      ];

      const afterBuilding = {
        tool: "calculateMaxGap",
        args: {
          runwayTiles,
          deltaYTiles: recommended.risesTiles,
          takeoffTile: { x: tx, y: ty },
          targetTile: recommended.playerLandsOn,
          gapTiles: recommended.gapTiles,
          difficulty,
        },
        expect:
          "proposed.tier at or below the requiredTier and allowedAtThisDifficulty true. Anything else means the build deviated from the option — fix it before replying.",
      };

      const playerTip =
        recommended.timingSlackMs < 100
          ? `This jump is at the limit and needs the max-distance technique: sprint the whole runway holding ${dir === 1 ? "right" : "left"}, run STRAIGHT OFF the edge without slowing, press jump a split second AFTER leaving the edge (coyote time), and keep jump held. Jumping at the edge the normal way falls short.`
          : undefined;

      return JSON.stringify({
        takeoffTile: { x: tx, y: ty },
        takeoffAdjusted,
        direction: args.direction ?? "right",
        runwayTiles,
        ceilingTiles: ceilingTiles ?? null,
        platformWidthTiles: width,
        levelDifficulty: difficulty,
        requiredTier: tier,
        intent,
        recommended: {
          ...recommended,
          hardness: describeHardness(recommended.timingSlackMs),
        },
        buildIt,
        afterBuilding,
        playerTip,
        options,
        rules: [
          "USE 'recommended' UNLESS YOU HAVE A REASON NOT TO. It already matches the requested intent.",
          "This is meant to be a HARD jump. Do not soften it, do not move the platform closer, and do not apologise for the difficulty — the player asked for the limit.",
          "Each option is a COMPLETE placement. Never take x from one option and y from another — that produces a jump no option endorsed and the player cannot make it.",
          "Build by executing 'buildIt' IN ORDER, passing each entry's args verbatim. The clearTile calls are not optional: they dig the gap that makes this a jump at all.",
          "If you build a different option instead, derive the same calls from its fields: clearTheseTilesFirst rects -> clearTile (xMin=fromX, xMax=toX, yMin=fromY, yMax=toY), then if needsBlockPlacement, placeGridofTiles tileIndex 4 across placeSolidBlocksAt fromX..toX at row y. NEVER place blocks at playerLandsOn — that is the empty cell the player occupies, one row above the blocks.",
          "Do not move the platform further across or higher than the option you picked. These are limits, not suggestions.",
          "Rising costs reach: the highest option is never also the furthest.",
          "After building, run 'afterBuilding' and check its expectation. verifyComplete passing does NOT prove this jump works — the player may be able to reach the platform another way.",
          "If playerTip is present, include it in your reply — at this difficulty the player cannot make the jump without the technique it describes.",
        ],
      });
    },
    {
      name: "findFurthestPlacement",
      schema: FindFurthestPlacement.argsSchema,
      description:
        "Find where a platform can be placed so the player can still jump to it from a given takeoff point, at the limit of what is reachable. " +
        "Use this whenever the player asks for something 'as far as possible', 'as high as possible', 'at the very edge', or otherwise at the limit. " +
        "Returns complete, ready-to-build placements — the exact tiles to clear (digging the gap out of existing ground where needed), the exact blocks to place, and the cell the player will land on — computed by simulating the real game physics against the live map, including real run-up and ceilings. " +
        "Every option is clamped to the map and the selection box, so anything it returns is safe to build. " +
        "Pass 'intent' to say what the player actually asked for, then execute the returned 'buildIt' calls verbatim.",
    },
  );
}
