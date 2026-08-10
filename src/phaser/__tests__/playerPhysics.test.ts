import { describe, expect, it } from "vitest";
import {
  createMovementState,
  GRAVITY_PX,
  JUMP_VELOCITY_PX,
  MAX_RUN_SPEED_PX,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  TILE,
} from "../playerPhysics";

/**
 * Frame-by-frame simulator mirroring how Phaser Arcade integrates around
 * stepMovement(): controller runs first, then the world applies gravity
 * (semi-implicit Euler), moves the body, and resolves floor collision.
 * Floor is at y = 0; up is negative y (Phaser convention).
 */
class Sim {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  onGround = true;
  floor = true;
  minY = 0;
  jumps = 0;
  frame = 0;
  private state = createMovementState();
  private prevJump = false;
  private dt: number;

  constructor(dt: number) {
    this.dt = dt;
  }

  step(move: -1 | 0 | 1, jump: boolean) {
    const jumpJustPressed = jump && !this.prevJump;
    this.prevJump = jump;

    const r = stepMovement(
      this.state,
      { moveInput: move, jumpHeld: jump, jumpJustPressed },
      this.vx,
      this.vy,
      this.onGround,
      this.dt,
    );
    this.vx = r.velocityX;
    this.vy = r.velocityY;
    if (r.jumped) this.jumps++;

    // World step (Arcade equivalent)
    this.vy = Math.min(this.vy + GRAVITY_PX * this.dt, TERMINAL_VELOCITY_PX);
    this.x += this.vx * this.dt;
    this.y += this.vy * this.dt;
    if (this.floor && this.y >= 0 && this.vy > 0) {
      this.y = 0;
      this.vy = 0;
      this.onGround = true;
    } else {
      this.onGround = this.floor && this.y === 0 && this.vy === 0;
    }
    this.minY = Math.min(this.minY, this.y);
    this.frame++;
  }

  get apexTiles() {
    return -this.minY / TILE;
  }
  get xTiles() {
    return this.x / TILE;
  }
}

const FPS_60 = 1 / 60;
const FPS_30 = 1 / 30;
const FPS_144 = 1 / 144;
const ALL_RATES = [FPS_30, FPS_60, FPS_144];

/** Jump on frame 0 with `holdFrames` of jump held, run until landing. */
function jumpAndLand(dt: number, holdFrames: number, move: -1 | 0 | 1 = 0) {
  const sim = new Sim(dt);
  sim.step(move, true); // jump fires here
  expect(sim.jumps).toBe(1);
  let frames = 1;
  while (!sim.onGround && frames < 1000) {
    sim.step(move, frames < holdFrames);
    frames++;
  }
  expect(sim.onGround).toBe(true);
  return sim;
}

describe("preserved constants", () => {
  it("jump impulse derives to the legacy -550 px/s", () => {
    expect(JUMP_VELOCITY_PX).toBeCloseTo(-550, 0);
  });

  it("top speed derives to the legacy 400 px/s", () => {
    expect(MAX_RUN_SPEED_PX).toBe(400);
  });
});

describe("jump height", () => {
  it("full-hold apex is ~6 tiles at 60fps (preserved)", () => {
    const sim = jumpAndLand(FPS_60, 10_000);
    expect(sim.apexTiles).toBeGreaterThan(5.8);
    expect(sim.apexTiles).toBeLessThan(6.4);
  });

  it("full-hold apex is consistent across frame rates", () => {
    const apexes = ALL_RATES.map((dt) => jumpAndLand(dt, 10_000).apexTiles);
    for (const apex of apexes) {
      expect(apex).toBeGreaterThan(5.6);
      expect(apex).toBeLessThan(6.5);
    }
    const spread = (Math.max(...apexes) - Math.min(...apexes)) / Math.max(...apexes);
    expect(spread).toBeLessThan(0.1);
  });

  it("tap jump is ~1.4 tiles (preserved)", () => {
    const sim = jumpAndLand(FPS_60, 1);
    expect(sim.apexTiles).toBeGreaterThan(1.1);
    expect(sim.apexTiles).toBeLessThan(1.8);
  });

  it("mid release (5 frames) is ~3 tiles (preserved)", () => {
    const sim = jumpAndLand(FPS_60, 5);
    expect(sim.apexTiles).toBeGreaterThan(2.5);
    expect(sim.apexTiles).toBeLessThan(3.5);
  });

  it("jump-cut applies only once", () => {
    const sim = new Sim(FPS_60);
    sim.step(0, true);
    sim.step(0, true);
    sim.step(0, false); // release → cut this frame
    const cutVy = sim.vy;
    sim.step(0, false); // must NOT cut again: only gravity applies
    expect(sim.vy).toBeCloseTo(cutVy + GRAVITY_PX * FPS_60, 5);
  });
});

describe("horizontal movement", () => {
  it("reaches exactly top speed within 0.3s from rest, at all frame rates", () => {
    for (const dt of ALL_RATES) {
      const sim = new Sim(dt);
      let t = 0;
      while (sim.vx < MAX_RUN_SPEED_PX && t < 1) {
        sim.step(1, false);
        t += dt;
      }
      expect(sim.vx).toBe(MAX_RUN_SPEED_PX);
      expect(t).toBeLessThanOrEqual(0.3);
    }
  });

  it("stops from top speed in ~4 tiles on the ground (preserved)", () => {
    const sim = new Sim(FPS_60);
    sim.vx = MAX_RUN_SPEED_PX;
    while (sim.vx > 0) sim.step(0, false);
    expect(sim.xTiles).toBeGreaterThan(3.6);
    expect(sim.xTiles).toBeLessThan(4.3);
  });

  it("stopping distance is consistent across frame rates", () => {
    const distances = ALL_RATES.map((dt) => {
      const sim = new Sim(dt);
      sim.vx = MAX_RUN_SPEED_PX;
      while (sim.vx > 0) sim.step(0, false);
      return sim.xTiles;
    });
    const spread =
      (Math.max(...distances) - Math.min(...distances)) / Math.max(...distances);
    expect(spread).toBeLessThan(0.1);
  });
});

describe("standing-jump gap (preserved ~6.1 tiles)", () => {
  it("covers ~6.1 tiles at 60fps", () => {
    const sim = jumpAndLand(FPS_60, 10_000, 1);
    expect(sim.xTiles).toBeGreaterThan(5.7);
    expect(sim.xTiles).toBeLessThan(6.5);
  });

  it("is consistent across frame rates", () => {
    const gaps = ALL_RATES.map((dt) => jumpAndLand(dt, 10_000, 1).xTiles);
    const spread = (Math.max(...gaps) - Math.min(...gaps)) / Math.max(...gaps);
    expect(spread).toBeLessThan(0.1);
  });
});

describe("coyote time", () => {
  function runOffLedge(fallFrames: number) {
    const sim = new Sim(FPS_60);
    for (let i = 0; i < 5; i++) sim.step(1, false); // run on ground
    sim.floor = false; // ledge ends
    sim.onGround = false;
    for (let i = 0; i < fallFrames; i++) sim.step(1, false);
    sim.step(1, true); // press jump
    return sim;
  }

  it("jump still fires ~83ms after leaving the ledge", () => {
    expect(runOffLedge(4).jumps).toBe(1);
  });

  it("jump does NOT fire ~133ms after leaving the ledge", () => {
    expect(runOffLedge(8).jumps).toBe(0);
  });

  it("cannot double-jump from one grace window", () => {
    const sim = jumpAndLand(FPS_60, 2);
    // Mid-air press during the same jump must not fire again
    const jumpsAfterLanding = sim.jumps;
    expect(jumpsAfterLanding).toBe(1);
    const sim2 = new Sim(FPS_60);
    sim2.step(0, true);
    sim2.step(0, false);
    sim2.step(0, true); // re-press while rising
    sim2.step(0, true);
    expect(sim2.jumps).toBe(1);
  });
});

describe("jump buffering", () => {
  /** Drop from 100px up; optionally press jump `pressFramesBeforeLand` early. */
  function drop(pressFramesBeforeLand: number | null) {
    // First find the landing frame without pressing.
    const probe = new Sim(FPS_60);
    probe.floor = true;
    probe.y = -100;
    probe.onGround = false;
    let landFrame = 0;
    while (!probe.onGround && landFrame < 1000) {
      probe.step(0, false);
      landFrame++;
    }
    // Re-run with a buffered press.
    const sim = new Sim(FPS_60);
    sim.y = -100;
    sim.onGround = false;
    for (let f = 0; f < landFrame + 5; f++) {
      const press =
        pressFramesBeforeLand !== null && f >= landFrame - pressFramesBeforeLand;
      sim.step(0, press);
    }
    return sim;
  }

  it("press ~83ms before landing fires the jump on landing", () => {
    expect(drop(5).jumps).toBe(1);
  });

  it("press ~150ms before landing is NOT buffered", () => {
    expect(drop(9).jumps).toBe(0);
  });

  it("no press, no jump", () => {
    expect(drop(null).jumps).toBe(0);
  });
});
