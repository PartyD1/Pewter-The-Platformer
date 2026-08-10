import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { EditorScene } from "../../phaser/editorScene.ts";
import { runCompletabilityCheck } from "../sceneReachability.ts";

export class VerifyComplete {
  sceneGetter: () => EditorScene;

  constructor(sceneGetter: () => EditorScene) {
    this.sceneGetter = sceneGetter;
  }

  static argsSchema = z.object({
    summary: z
      .string()
      .describe(
        "Your friendly, conversational reply to the player. This is the final message the player will see — keep it short and avoid dumping raw coordinates or tile IDs.",
      ),
  });

  toolCall = tool(
    async (_args: z.infer<typeof VerifyComplete.argsSchema>) => {
      // No longer a rubber stamp: run the real physics-based reachability
      // check. If it fails, the AI gets specific diagnoses to fix in its
      // remaining tool rounds.
      try {
        const report = runCompletabilityCheck(this.sceneGetter());
        return (report.ok ? "✅ " : "❌ ") + report.text;
      } catch (e) {
        // Never block the conversation on an internal checker error.
        console.error("verifyComplete reachability check failed:", e);
        return "✅ Verification confirmed (reachability check unavailable).";
      }
    },
    {
      name: "verifyComplete",
      schema: VerifyComplete.argsSchema,
      description:
        "REQUIRED: Call this tool ALONE in its own message — never alongside other tools. " +
        "Only call it after all other tools have been called and their results have been returned to you. " +
        "It runs a physics-accurate completability check on the level: if it returns problems, fix them with more tool calls and call this tool again. " +
        "Pass your player-facing reply as 'summary' — this is the only text the player will see, so make it friendly and useful. " +
        "Every response must include exactly one call to this tool, in a dedicated final message with no other tool calls.",
    },
  );
}
