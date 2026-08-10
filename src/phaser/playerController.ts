/**
 * Phaser-facing player controller, shared by GameScene and EditorScene's
 * playtest mode. All physics math lives in playerPhysics.ts (pure, tested);
 * this file only reads input, applies the results to the Arcade body, and
 * fires scene hooks (VFX etc.).
 */
import Phaser from "phaser";
import {
  createMovementState,
  GRAVITY_PX,
  MAX_RUN_SPEED_PX,
  MAX_STEP_DT,
  stepMovement,
  TERMINAL_VELOCITY_PX,
  type PlayerMovementState,
} from "./playerPhysics";

/**
 * The player art (tileset frame 14, the knight) faces RIGHT by default —
 * verified against pewterPlatformerTilesetExtended.png. So the sprite is
 * mirrored when moving left, and keeps its last facing when idle.
 */
const SPRITE_FACES_RIGHT = true;

type ControllablePlayer = Phaser.Types.Physics.Arcade.SpriteWithDynamicBody & {
  isFalling?: boolean;
};

export interface PlayerControllerHooks {
  /** Fired on the frame a jump impulse is applied. */
  onJump?: () => void;
  /** Fired each frame the player is running on the ground. */
  onWalk?: () => void;
  /** Fired each frame the player is NOT running on the ground. */
  onStopWalking?: () => void;
}

/**
 * Configure the player sprite + physics body identically in every scene.
 *
 * Body sizing note: Arcade multiplies `setSize` values by the sprite's
 * scale (Body.updateBounds: width = sourceWidth * scaleX — verified in
 * phaser 3.90 source). At scale 1 the body is exactly 10×14 px, matching
 * the editor playtest's long-standing hitbox (~0.6×0.9 tiles, so the
 * player fits through 1-tile gaps). GameScene previously used scale 2 with
 * no setSize, i.e. a 32×32 body and a knight rendered 2 tiles tall — that
 * inconsistency is what this helper removes.
 */
export function configurePlayerSprite(player: ControllablePlayer): void {
  player.setScale(1);
  player.setSize(10, 14).setOffset(3, 1);
  player.setCollideWorldBounds(false);
  player.setDrag(0, 0);
  // Engine-level safety net; normal movement is capped by stepMovement.
  player.setMaxVelocity(MAX_RUN_SPEED_PX, TERMINAL_VELOCITY_PX);
}

/** World gravity for scenes with an active player, in px/s². */
export const WORLD_GRAVITY_Y = GRAVITY_PX;

export class PlayerController {
  private readonly player: ControllablePlayer;
  private readonly hooks: PlayerControllerHooks;
  private readonly cursors: Phaser.Types.Input.Keyboard.CursorKeys;
  private readonly wasd: Record<"W" | "A" | "S" | "D", Phaser.Input.Keyboard.Key>;
  private readonly state: PlayerMovementState = createMovementState();
  private prevJumpHeld = false;

  constructor(
    scene: Phaser.Scene,
    player: ControllablePlayer,
    hooks: PlayerControllerHooks = {},
  ) {
    this.player = player;
    this.hooks = hooks;
    const keyboard = scene.input.keyboard!;
    this.cursors = keyboard.createCursorKeys();
    this.wasd = keyboard.addKeys("W,A,S,D") as PlayerController["wasd"];
  }

  /** Call once per frame with Phaser's real `delta` (milliseconds). */
  update(deltaMs: number): void {
    const player = this.player;
    const body = player.body;
    const onGround = body.blocked.down;
    const dt = Math.min(deltaMs / 1000, MAX_STEP_DT);

    const left = this.cursors.left.isDown || this.wasd.A.isDown;
    const right = this.cursors.right.isDown || this.wasd.D.isDown;
    const moveInput: -1 | 0 | 1 = left ? -1 : right ? 1 : 0; // left wins
    const jumpHeld = this.cursors.up.isDown || this.wasd.W.isDown;
    const jumpJustPressed = jumpHeld && !this.prevJumpHeld;
    this.prevJumpHeld = jumpHeld;

    const result = stepMovement(
      this.state,
      { moveInput, jumpHeld, jumpJustPressed },
      body.velocity.x,
      body.velocity.y,
      onGround,
      dt,
    );
    player.setVelocity(result.velocityX, result.velocityY);

    if (moveInput !== 0) {
      player.setFlipX(SPRITE_FACES_RIGHT ? moveInput < 0 : moveInput > 0);
    }

    if (result.jumped) {
      player.isFalling = false;
      this.hooks.onJump?.();
    }
    if (moveInput !== 0 && onGround) {
      this.hooks.onWalk?.();
    } else {
      this.hooks.onStopWalking?.();
    }

    if (onGround) {
      player.isFalling = false;
    } else if (result.velocityY > 0) {
      player.isFalling = true;
    }
  }

  /** Zero velocity and clear timers/latches. Call on respawn/death. */
  reset(): void {
    this.player.setVelocity(0, 0);
    this.state.coyoteTimer = 0;
    this.state.jumpBufferTimer = 0;
    this.state.canCutJump = false;
    this.prevJumpHeld = false;
  }
}
