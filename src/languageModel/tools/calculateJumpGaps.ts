import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { EditorScene } from "../../phaser/editorScene.ts";
import { calculateMaxGap } from "../../phaser/playerPhysics.ts";

export class CalculateJumpGaps {
  sceneGetter: () => EditorScene;

  constructor(sceneGetter: () => EditorScene) {
    this.sceneGetter = sceneGetter;
  }

  toolCall = tool(
    async ({ runwayTiles, deltaYTiles }) => {
      // Run your pure physics function
      const maxGap = calculateMaxGap(runwayTiles, -deltaYTiles);
      const safeGap = Math.floor(maxGap);

      console.log(
        `[Tool Executed] runway: ${runwayTiles}, deltaY: ${deltaYTiles} -> Safe Gap: ${safeGap}`,
      );

      // LangChain tools return stringified results back to the LLM agent
      return JSON.stringify({
        runwayTiles,
        deltaYTiles,
        maxAllowedGapTiles: safeGap,
      });
    },
    {
      name: "calculateMaxGap",
      description:
        "Calculates the exact maximum safe horizontal jump gap (in tiles). You MUST pass runwayTiles and deltaYTiles to this tool FIRST, and set your gap equal to maxAllowedGapTiles. Never guess or hallucinate gap sizes.",
      schema: z.object({
        runwayTiles: z
          .number()
          .describe("Width of the takeoff platform in tiles (runway)."),
        deltaYTiles: z
          .number()
          .describe(
            "Elevation change to target platform in tiles (negative = DROP DOWN, positive = JUMP UP).",
          ),
      }),
    },
  );
}
