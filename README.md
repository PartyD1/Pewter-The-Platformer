<!-- Back to top link -->

<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->

[![Contributors][contributors-shield]][contributors-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![Deploy][deploy-shield]][deploy-url]

<br />
<div align="center">

  <img src="public/favicon.png" alt="Pewter" width="96" height="96">

  <h1 align="center">Pewter The Platformer</h1>

  <p align="center">
    Draw a box. Describe a level. Pewter builds it, then proves it can be beaten.
    <br />
    <br />
    <a href="https://namea42.github.io/Pewter-The-Platformer/">View Live Demo</a>
    &middot;
    <a href="https://github.com/PartyD1/Pewter-The-Platformer/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/PartyD1/Pewter-The-Platformer/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

---

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About the Project</a></li>
    <li><a href="#features">Features</a></li>
    <li><a href="#built-with">Built With</a></li>
    <li><a href="#how-it-works">How It Works</a></li>
    <li><a href="#the-physics-model">The Physics Model</a></li>
    <li><a href="#llm-tool-reference">LLM Tool Reference</a></li>
    <li><a href="#controls">Controls</a></li>
    <li><a href="#tile-reference">Tile Reference</a></li>
    <li><a href="#project-structure">Project Structure</a></li>
    <li><a href="#running-locally">Running Locally</a></li>
    <li><a href="#testing">Testing</a></li>
    <li><a href="#deployment">Deployment</a></li>
    <li><a href="#custom-enemies-cedl">Custom Enemies (CEDL)</a></li>
    <li><a href="#troubleshooting">Troubleshooting</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

---

<!-- ABOUT THE PROJECT -->

## About the Project

Pewter is a browser-based 2D platformer level editor with an AI co-designer built in. You draw a selection box on a tile map, tell **Pewter** what you want in plain English, and it places, clears, and rearranges tiles for you through a set of typed tool calls. Press **Play** and the level is instantly runnable with the real game physics.

What makes Pewter different from "an LLM that emits tile coordinates" is that it refuses to guess. Every jump it designs is checked against a **frame-by-frame simulation of the actual player physics**, so a platform is never placed one tile too far. Before it replies, Pewter is required to run a full reachability check on the level. If something is not beatable, it fixes it before you ever see the result.

The project is a demonstration of **LLM tool calling through LangChain** applied to a game world: the model orchestrates a dozen purpose-built tools, each with a strict schema, and the game engine grounds every decision in real state.

**Live:** [https://namea42.github.io/Pewter-The-Platformer/](https://namea42.github.io/Pewter-The-Platformer/)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- FEATURES -->

## Features

- **Natural-language level editing:** describe platforms, gaps, collectables, or whole sections and Pewter builds them inside your selection box
- **Selection-box scoping:** the AI can only touch tiles inside the box you drew, so it never wrecks the rest of your map
- **Physics-accurate jump solver:** every gap is validated by simulating real acceleration, gravity, run-up, and ceilings at 30, 60, and 144 fps
- **Difficulty spectrum, not a single number:** each jump is graded by how many milliseconds of timing slack it leaves the player
- **Limit requests done honestly:** ask for a platform "as far as possible" and Pewter computes the true edge of reachability instead of softening it
- **Mandatory completability check:** Pewter must call a reachability verifier before replying, and must fix any problems it reports
- **Instant playtesting:** hit Play to drop in with tuned movement, coyote time, jump buffering, and variable jump height
- **Full undo/redo history:** every click and every AI edit is a snapshot, steppable by keyboard or by asking Pewter
- **Copy, cut, and paste** regions of the map between selection boxes
- **Layered selection boxes:** stack boxes with Z-levels so overlapping regions resolve predictably
- **Debug overlay** in play mode for inspecting physics bodies and collisions
- **Custom Enemy Definition Language (CEDL):** a YAML-based schema for LLM-authored enemies with state-machine behaviors and projectile patterns (currently behind a feature flag)
- **Frame-rate independent movement:** locked in by tests, so the level that is beatable at 60 fps is beatable at 144 fps
- **Auto-deploys** to GitHub Pages on every push to main

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- TECH STACK -->

## Built With

[![Phaser][Phaser-badge]][Phaser-url]
[![TypeScript][TypeScript-badge]][TypeScript-url]
[![Vite][Vite-badge]][Vite-url]
[![LangChain][LangChain-badge]][LangChain-url]
[![Gemini][Gemini-badge]][Gemini-url]
[![Zod][Zod-badge]][Zod-url]
[![Vitest][Vitest-badge]][Vitest-url]
[![Prettier][Prettier-badge]][Prettier-url]
[![GitHub Pages][Pages-badge]][Pages-url]

| Layer             | Choice                                      | Why                                                                                    |
| ----------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Game engine       | Phaser 3 with Arcade Physics                | Fast 2D tilemaps, built-in DOM support for the chat panel                              |
| Language model    | Google Gemini via `@langchain/google-genai` | Native tool calling, low latency, temperature pinned at 0.3 for deterministic tool use |
| Tool schemas      | Zod 4                                       | Every tool argument is validated before it touches the map                             |
| Pathfinding       | EasyStar.js                                 | Grid pathfinding for enemy movement                                                    |
| Enemy definitions | YAML                                        | Human-readable CEDL that LLMs generate reliably                                        |
| Sprite generation | PixelLab API (optional)                     | AI-generated enemy sprites, gated behind a credit-protection toggle                    |
| Testing           | Vitest                                      | Pure-math physics and solver modules run without a browser                             |
| Formatting        | Prettier via Husky + lint-staged            | Enforced on every commit                                                               |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- HOW IT WORKS -->

## How It Works

```
Draw Selection Box  ->  Chat Prompt  ->  Gemini + Tool Loop (max 8 rounds)  ->  Physics Checks  ->  verifyComplete  ->  Map Updated + Snapshot Saved
```

1. You drag a selection box on the map and type a request in the chat panel
2. The system prompt is rebuilt from live state: the current difficulty policy and movement facts derived directly from the physics constants
3. Gemini receives the prompt plus a dozen registered tools and starts a tool-calling loop, up to 8 rounds
4. Analysis tools (`calculateMaxGap`, `findFurthestPlacement`, `checkTraversal`) are free to call and simulate the real physics against the live map
5. Write tools (`placeSingleTile`, `placeGridofTiles`, `clearTiles`) are clamped to the selection box and rejected if they stray outside it
6. Pewter must finish with exactly one call to `verifyComplete`, which runs a full reachability sweep from spawn. If it reports problems, Pewter loops again to fix them
7. The player-facing summary from `verifyComplete` is shown in chat, and if any write tool ran, a world snapshot is saved for undo
8. Press **Play** to test the level with the same physics the solver simulated

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- PHYSICS -->

## The Physics Model

All movement constants live in one place, expressed in **tiles and seconds** so level-design numbers fall out of them directly. The step functions are pure math with no Phaser dependency, which is what lets the jump solver and the test suite simulate them frame by frame.

| Constant            | Value           | What it means for level design                                          |
| ------------------- | --------------- | ----------------------------------------------------------------------- |
| Tile size           | 16 px           | The only tiles-to-pixels conversion                                     |
| Max run speed       | 16 tiles/s      | Caps the longest crossable gap at roughly 11.7 tiles                    |
| Ground acceleration | 20 tiles/s²     | 0 to max in about 0.8 s over 6.4 tiles, so max jumps need a real run-up |
| Jump height         | 6.3 tiles       | Jump velocity is derived from this, not the other way round             |
| Gravity             | 93.75 tiles/s²  | 1500 px/s²                                                              |
| Standing jump       | about 5.4 tiles | The floor of the crossable-gap range                                    |
| Coyote time         | 60 ms           | Jump still fires briefly after leaving a ledge                          |
| Jump buffer         | 100 ms          | An early press is queued until landing                                  |
| Jump cut            | 0.4x            | Releasing early shortens the jump                                       |

The crossable-gap range is deliberately narrow (about 5.4 to 11.7 tiles, a 2:1 ratio) so the AI has a small, well-defined space to reason about. Run-up, ceilings, and takeoff geometry are read from the live map rather than trusted from the model's arithmetic.

Design notes and the history of the rework are in `src/phaser/PLAYER_MOVEMENT_DEEP_DIVE.md`, `src/phaser/JUMP_SOLVER_REWORK_PLAN.md`, and `src/languageModel/PEWTER_PHYSICS_AWARENESS_PLAN.md`.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- TOOL REFERENCE -->

## LLM Tool Reference

Every tool is a class that exposes a Zod-validated `toolCall` and is registered with the model at startup in `src/main.ts`.

| Tool                    | Type     | Description                                                                                                                                |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `placeSingleTile`       | Write    | Place one tile at `(x, y)` on a layer. Enemy tiles are forced onto the ground layer                                                        |
| `placeGridofTiles`      | Write    | Fill a rectangle with a tile index                                                                                                         |
| `clearTiles`            | Write    | Clear a rectangle on both layers and remove any enemies inside it                                                                          |
| `getWorldFacts`         | Read     | Stored facts about the world grouped by Structure, Collectable, and Enemy                                                                  |
| `getPlacedTiles`        | Read     | Every tile inside the active selection box with index, coordinates, and layer                                                              |
| `relativeGeneration`    | Read     | Non-empty tiles inside the selection, in tile coordinates                                                                                  |
| `calculateMaxGap`       | Analysis | Simulate the real physics to find the widest crossable gap, graded by timing slack, with run-up and ceilings read from the live map        |
| `findFurthestPlacement` | Analysis | Return complete, ready-to-build placements at the true limit of reachability, including the exact `clearTiles` calls needed to dig the gap |
| `checkTraversal`        | Analysis | Physics-accurate reachability sweep of the whole map plus a difficulty rating. Read-only and free                                          |
| `verifyComplete`        | Required | Final completability check. Carries the player-facing summary and must be the last call in every response                                  |
| `undoRedo`              | Write    | Step backward or forward through world snapshots                                                                                           |

Enemy authoring tools (`generateEnemy`, `modifyEnemy`, `placeEnemy`) exist in the codebase but are currently commented out of the registration list.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- CONTROLS -->

## Controls

### Editor mode

| Key                                    | Action                                             |
| -------------------------------------- | -------------------------------------------------- |
| Click and drag                         | Draw a selection box                               |
| `N`                                    | Finalize the active selection box                  |
| `W` `A` `S` `D`                        | Pan the camera                                     |
| `Shift` + pan                          | Pan 4x faster                                      |
| `P` / `O`                              | Raise / lower the active box's Z-level             |
| `Ctrl` + `C` / `X` / `V`               | Copy / cut / paste the selection at the cursor     |
| `Ctrl` + `Z`                           | Undo                                               |
| `Ctrl` + `Y` or `Ctrl` + `Shift` + `Z` | Redo                                               |
| `U`                                    | Toggle the chat panel and toolbar                  |
| `H`                                    | Print the active box's placed tiles to the console |

### Play mode

| Key                | Action                                               |
| ------------------ | ---------------------------------------------------- |
| `←` `→` or `A` `D` | Run                                                  |
| `↑` or `W`         | Jump (hold for full height, release early to cut it) |
| `Q`                | Quit back to the editor                              |
| `G`                | Toggle the physics debug overlay                     |
| `B`                | Toggle selection-box visibility                      |

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- TILES -->

## Tile Reference

The default map is 20 tiles tall. The bottom 5 rows are solid ground and the top 15 are open sky. Two layers are editable: `Ground_Layer` and `Collectables_Layer`.

| ID  | Tile                | Category    | Layer                |
| --- | ------------------- | ----------- | -------------------- |
| 2   | Coin                | Collectable | `Collectables_Layer` |
| 3   | Fruit               | Collectable | `Collectables_Layer` |
| 4   | Platform block      | Ground      | `Ground_Layer`       |
| 5   | Dirt block          | Ground      | `Ground_Layer`       |
| 6   | Grass block         | Ground      | `Ground_Layer`       |
| 7   | Question-mark block | Ground      | `Ground_Layer`       |
| 8   | Ultra Slime         | Enemy       | `Ground_Layer`       |
| 9   | Slime               | Enemy       | `Ground_Layer`       |

Coordinates follow screen convention: X grows to the right and Y grows downward.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- PROJECT STRUCTURE -->

## Project Structure

```
Pewter-The-Platformer/
├── index.html                          # Page shell; mounts the Phaser canvas
├── vite.config.ts                      # Base path for GitHub Pages + Vitest excludes
├── .github/workflows/deploy.yml        # Build + deploy to GitHub Pages on push to main
├── .husky/pre-commit                   # Runs lint-staged (Prettier) on every commit
│
├── public/
│   ├── favicon.png
│   └── phaserAssets/                   # Tilesets, Tiled maps, particles, backgrounds, audio
│
└── src/
    ├── main.ts                         # Registers LLM tools, boots the Phaser game
    ├── style.css
    │
    ├── phaser/                         # Game engine layer
    │   ├── loadingScene.ts             # Asset preload
    │   ├── editorScene.ts              # Tile map, selection boxes, camera, clipboard, undo/redo, play mode
    │   ├── UIScene.ts                  # Toolbar, chat panel, Play button, HUD
    │   ├── gameScene.ts                # Standalone play scene
    │   ├── selectionBox.ts             # Selection box geometry and Z-levels
    │   ├── playerPhysics.ts            # Pure-math movement constants and step functions
    │   ├── playerController.ts         # Phaser wrapper around playerPhysics
    │   ├── movementCapabilities.ts     # Derived level-design numbers (jump height, gap ranges)
    │   ├── jumpSolver.ts               # Frame-by-frame jump simulation against the live map
    │   ├── regenerator.ts              # Region regeneration helpers
    │   ├── OverlapChecker.ts
    │   ├── colors.ts
    │   ├── ExternalClasses/            # Slime, UltraSlime, Pathfinding, worldFacts, RegenerationTools
    │   ├── __tests__/                  # Physics, solver, and reachability test suites
    │   ├── PLAYER_MOVEMENT_DEEP_DIVE.md
    │   ├── PLAYER_CONTROLLER_PHYSICS.md
    │   ├── PLAYER_MOVEMENT_REWORK_PLAN.md
    │   └── JUMP_SOLVER_REWORK_PLAN.md
    │
    ├── languageModel/                  # LLM layer
    │   ├── modelConnector.ts           # Gemini client, tool registry, bindTools
    │   ├── chatBox.ts                  # Chat UI, tool-calling loop, snapshot triggers
    │   ├── systemPrompt.ts             # buildSystemPrompt(), asserted directly by tests
    │   ├── movementPrompt.ts           # Movement facts derived from playerPhysics
    │   ├── designPolicy.ts             # Default difficulty policy ("challenging but fair")
    │   ├── reachability.ts             # Reachability engine
    │   ├── sceneReachability.ts        # Adapter from the live scene to the engine
    │   ├── placementOptions.ts         # Candidate placements for limit requests
    │   ├── tools/                      # One file per LLM tool
    │   ├── __tests__/
    │   └── PEWTER_PHYSICS_AWARENESS_PLAN.md
    │
    └── enemySystem/                    # Custom Enemy Definition Language (feature-flagged)
        ├── cedl/                       # YAML schema, parser, templates, types
        ├── runtime/                    # DynamicEnemy, StateMachine, TerrainAwareness, Projectiles, Effects
        ├── factory/EnemyFactory.ts
        ├── sprite/SpriteGenerator.ts   # Optional PixelLab integration
        ├── EnemyRegistry.ts
        ├── FEATURES.md
        └── ENEMY_GENERATION_TESTING.md
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- INSTALLATION -->

## Running Locally

**Prerequisites:** Node.js 20+, a Google Gemini API key

```
git clone https://github.com/PartyD1/Pewter-The-Platformer.git
cd Pewter-The-Platformer
```

```
npm install
```

Create a `.env` file in the project root:

```
VITE_LLM_API_KEY=your_gemini_api_key
VITE_LLM_MODEL_NAME=gemini-2.5-flash
```

Start the dev server:

```
npm run dev
```

Open the URL Vite prints (usually [http://localhost:5173](http://localhost:5173)). Draw a selection box on the map, then ask Pewter for something in the chat panel.

> The app throws at startup if either environment variable is missing. `.env` is gitignored, so it never leaves your machine.

Other scripts:

```
npm run build      # production build to dist/
npm run preview    # serve the production build locally
npm test           # run the Vitest suite once
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- TESTING -->

## Testing

The physics, jump solver, reachability engine, and system prompt are all pure TypeScript modules, so they run under Vitest with no browser.

```
npm test
```

| Suite                                             | Covers                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `playerPhysics.test.ts`                           | Jump height, standing-jump gap, stop distance, frame-rate independence     |
| `movementCapabilities.test.ts`                    | Derived level-design numbers stay in sync with the constants               |
| `jumpSolver.test.ts` / `jumpSolverEngine.test.ts` | Gap grading, run-up, ceilings, difficulty tiers                            |
| `reachableFrontier.test.ts`                       | Frontier expansion from spawn                                              |
| `reachability.test.ts`                            | End-to-end completability on fixture maps                                  |
| `placementOptions.test.ts`                        | Limit-request placements are at the true edge and clamped to the map       |
| `prompts.test.ts`                                 | Asserts against `buildSystemPrompt()`, the exact string the model receives |

The prompt test exists for a reason: the movement and design-policy sections were once unit-tested in isolation while being called from nowhere, so Pewter shipped for months without ever seeing a movement fact. Testing the real prompt string means the sections cannot silently detach again.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- DEPLOYMENT -->

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds with Node 20 and publishes `dist/` to GitHub Pages.

To deploy your own fork:

1. Enable GitHub Pages for the repository with **GitHub Actions** as the source
2. Add two repository secrets: `VITE_LLM_API_KEY` and `VITE_LLM_MODEL_NAME`
3. Push to `main`, or run the workflow manually from the Actions tab

The Vite `base` is set to `/Pewter-The-Platformer/`. If you rename the repository, update it in `vite.config.ts`.

> Because this is a static site, the Gemini key is baked into the client bundle at build time. Use a key with usage limits and restrict it to your Pages origin.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- CEDL -->

## Custom Enemies (CEDL)

The `enemySystem/` folder implements a **Custom Enemy Definition Language**: a YAML format that lets the LLM author enemies with stats, a state machine, and projectile patterns, validated with detailed error messages so the model can iterate.

```yaml
enemy:
  name: "Fast Charger"
  stats:
    health: 20
    speed: 120
    damage_on_contact: 1
  behavior:
    initial_state: "patrol"
    states:
      - name: "patrol"
        actions:
          - type: "smart_patrol" # auto-avoids pits and walls
            distance: 5
        transitions:
          - condition: "player_distance < 6"
            target: "charge"
      - name: "charge"
        actions:
          - type: "move_toward_player"
```

It ships with a template library (Patrol Guard, Turret, Charger, Flyer, Sniper, Shotgunner, Bullet Hell, Homing Drone, Berserker, Teleporter), terrain-aware actions such as `smart_patrol` and `jump_to_platform`, and optional AI sprite generation through PixelLab. The tools are wired but commented out in `src/main.ts` while the level-design side stabilizes. See `src/enemySystem/FEATURES.md` and `ENEMY_GENERATION_TESTING.md` for the full spec.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- TROUBLESHOOTING -->

## Troubleshooting

**`Missing VITE_LLM_API_KEY in .env file!` on startup**
Create `.env` in the project root with both variables shown above, then restart `npm run dev`. Vite only reads `.env` at startup.

**`vitest: command not found`**
Dev dependencies are not installed:

```
npm install
```

**Pewter places things outside my box, or refuses to edit**
Make sure a selection box is active. Press `N` to finalize a box after drawing it. Pewter is hard-limited to the active box.

**A jump Pewter says is possible feels impossible**
Limit jumps require running off the edge and pressing jump just after leaving the platform. Coyote time is 60 ms, so it is tight by design. Ask Pewter for an "easy" level to widen the margins.

**Blank page on GitHub Pages**
The `base` in `vite.config.ts` must match the repository name, and both secrets must be set in the repository settings.

**Tests report every suite twice**
You are running from a checkout that has git worktrees under `.claude/worktrees/`. The Vitest config already excludes that path, so update `vite.config.ts` if you moved it.

**Pre-commit hook rewrote my files**
That is Prettier via lint-staged. Run `npx prettier --write .` before committing to see the changes up front.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- ROADMAP -->

## Roadmap

- [x] Physics-accurate jump solver with difficulty tiers
- [x] Mandatory reachability check before every reply
- [x] Limit requests ("as far as possible") build genuinely hard jumps
- [x] Terrain-aware furthest-placement tool with ready-to-build output
- [x] Undo/redo snapshots for both player and AI edits
- [ ] Re-enable the CEDL enemy generation tools
- [ ] Gate `tsc --noEmit` and `npm test` in CI

See the [open issues](https://github.com/PartyD1/Pewter-The-Platformer/issues) for the full list.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- LICENSE -->

## License

This repository does not currently include a license file. Contact the maintainers before reusing the code.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- CONTACT -->

## Contact

**Parth Doshi**

[![LinkedIn][linkedin-shield]][linkedin-url]
[![GitHub][github-shield]][github-url]

Project: [https://github.com/PartyD1/Pewter-The-Platformer](https://github.com/PartyD1/Pewter-The-Platformer)

Upstream: [https://github.com/nameA42/Pewter-The-Platformer](https://github.com/nameA42/Pewter-The-Platformer)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- ACKNOWLEDGMENTS -->

## Acknowledgments

Pewter is a team project built at UC Santa Cruz. Thanks to everyone who has shipped commits to it:

<a href="https://github.com/PartyD1/Pewter-The-Platformer/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=PartyD1/Pewter-The-Platformer" alt="Contributors" />
</a>

Assets and libraries that made it possible:

- [Phaser](https://phaser.io/) for the engine
- [Kenney](https://kenney.nl/) for the tileset, character sprites, and particle packs
- [Tiled](https://www.mapeditor.org/) for map authoring
- [LangChain](https://js.langchain.com/) for the tool-calling plumbing
- [EasyStar.js](https://easystarjs.com/) for pathfinding
- [PixelLab](https://www.pixellab.ai/) for optional sprite generation
- [Best-README-Template](https://github.com/othneildrew/Best-README-Template) for the layout this README follows

<p align="right">(<a href="#readme-top">back to top</a>)</p>

---

<!-- MARKDOWN LINKS -->

[contributors-shield]: https://img.shields.io/github/contributors/PartyD1/Pewter-The-Platformer.svg?style=for-the-badge
[contributors-url]: https://github.com/PartyD1/Pewter-The-Platformer/graphs/contributors
[stars-shield]: https://img.shields.io/github/stars/PartyD1/Pewter-The-Platformer.svg?style=for-the-badge
[stars-url]: https://github.com/PartyD1/Pewter-The-Platformer/stargazers
[issues-shield]: https://img.shields.io/github/issues/PartyD1/Pewter-The-Platformer.svg?style=for-the-badge
[issues-url]: https://github.com/PartyD1/Pewter-The-Platformer/issues
[deploy-shield]: https://img.shields.io/github/actions/workflow/status/PartyD1/Pewter-The-Platformer/deploy.yml?branch=main&style=for-the-badge&label=deploy
[deploy-url]: https://github.com/PartyD1/Pewter-The-Platformer/actions/workflows/deploy.yml
[linkedin-shield]: https://img.shields.io/badge/-LinkedIn-black.svg?style=for-the-badge&logo=linkedin&colorB=555
[linkedin-url]: https://www.linkedin.com/in/parthmdoshi/
[github-shield]: https://img.shields.io/badge/-GitHub-black.svg?style=for-the-badge&logo=github&colorB=555
[github-url]: https://github.com/PartyD1
[Phaser-badge]: https://img.shields.io/badge/Phaser_3-8B5CF6?style=for-the-badge&logo=phaser&logoColor=white
[Phaser-url]: https://phaser.io/
[TypeScript-badge]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Vite-badge]: https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white
[Vite-url]: https://vite.dev/
[LangChain-badge]: https://img.shields.io/badge/LangChain-1C3C3C?style=for-the-badge&logo=langchain&logoColor=white
[LangChain-url]: https://js.langchain.com/
[Gemini-badge]: https://img.shields.io/badge/Google_Gemini-4285F4?style=for-the-badge&logo=googlegemini&logoColor=white
[Gemini-url]: https://ai.google.dev/
[Zod-badge]: https://img.shields.io/badge/Zod-3E67B1?style=for-the-badge&logo=zod&logoColor=white
[Zod-url]: https://zod.dev/
[Vitest-badge]: https://img.shields.io/badge/Vitest-6E9F18?style=for-the-badge&logo=vitest&logoColor=white
[Vitest-url]: https://vitest.dev/
[Prettier-badge]: https://img.shields.io/badge/Prettier-F7B93E?style=for-the-badge&logo=prettier&logoColor=black
[Prettier-url]: https://prettier.io/
[Pages-badge]: https://img.shields.io/badge/GitHub_Pages-222222?style=for-the-badge&logo=github&logoColor=white
[Pages-url]: https://pages.github.com/
