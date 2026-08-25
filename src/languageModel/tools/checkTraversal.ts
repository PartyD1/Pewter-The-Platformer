import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { EditorScene } from "../../phaser/editorScene.ts";
import {
  currentTier,
  DIFFICULTY_TIER,
  LEVEL_DIFFICULTIES,
} from "../../phaser/movementCapabilities.ts";
import { runCompletabilityCheck } from "../sceneReachability.ts";

/**
 * Read-only traversal check: same engine verifyComplete uses, callable at
 * any point so the AI can validate a plan before (or while) building.
 */
export class CheckTraversal {
  sceneGetter: () => EditorScene;

  constructor(sceneGetter: () => EditorScene) {
    this.sceneGetter = sceneGetter;
  }

  static argsSchema = z.object({
    difficulty: z
      .enum(LEVEL_DIFFICULTIES)
      .optional()
      .describe(
        "Optional: check beatability at this difficulty instead of the level's current one. EASY demands jumps any player can make; HARD allows tight, expert-timed jumps.",
      ),
  });

  toolCall = tool(
    async (args: z.infer<typeof CheckTraversal.argsSchema>) => {
      try {
        const tier = args.difficulty
          ? DIFFICULTY_TIER[args.difficulty]
          : currentTier();
        const report = runCompletabilityCheck(this.sceneGetter(), tier);
        return (report.ok ? "✅ " : "❌ ") + report.text;
      } catch (e) {
        return `⚠️ Traversal check failed to run: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name: "checkTraversal",
      schema: CheckTraversal.argsSchema,
      description:
        "Run a physics-accurate reachability check over the whole map: which platforms the player can actually reach from spawn " +
        "(via walking, falling, and jumps limited by real run-up and jump physics), and whether every collectable is collectable. " +
        "Also reports the level's difficulty rating: the hardest jump tier it requires, and whether near-limit jumps chain together. " +
        "Read-only and free to call — use it to validate your plan before placing many tiles, or to answer questions about whether a level is beatable. " +
        "verifyComplete runs this same check at the end; using this early avoids wasted rounds.",
    },
  );
}
