import { defineConfig } from "vite";

export default defineConfig({
  base: "/Pewter-The-Platformer/",
  test: {
    // Git worktrees live under .claude/worktrees/ and carry full copies of
    // src/. Without this, a run from the main checkout collects every
    // worktree's tests too and reports each suite twice.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
  },
});
