import Phaser from "phaser";
import {
  configurePlayerSprite,
  PlayerController,
  WORLD_GRAVITY_Y,
} from "./playerController";

type VFX = {
  walking?: Phaser.GameObjects.Particles.ParticleEmitter;
  jump?: Phaser.GameObjects.Particles.ParticleEmitter;
};
type PlayerSprite = Phaser.Types.Physics.Arcade.SpriteWithDynamicBody & {
  isFalling?: boolean;
};

export class GameScene extends Phaser.Scene {
  private collectedItems = 0;
  private playerHP = 3;
  isUpDown = false;
  //private readonly acceleration = 400;
  //private readonly drag = 1100;
  //private readonly jumpVelocity = -600;
  private readonly particleVelocity = 50;
  private gameScale = 2;

  public map!: Phaser.Tilemaps.Tilemap;
  private passedmap!: Phaser.Tilemaps.Tilemap;
  private groundLayer!: Phaser.Tilemaps.TilemapLayer;
  private backgroundLayer!: Phaser.Tilemaps.TilemapLayer;
  private coinGroup!: Phaser.GameObjects.Group;
  //private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private coinText!: Phaser.GameObjects.Text;
  private hpText!: Phaser.GameObjects.Text;
  private background!: Phaser.GameObjects.TileSprite;
  private midground!: Phaser.GameObjects.TileSprite;
  private vfx: VFX = {};
  private player!: PlayerSprite;
  private playerController!: PlayerController;
  private editorButton!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: "GameScene" });
  }

  init(data: { map: Phaser.Tilemaps.Tilemap }) {
    this.collectedItems = 0;
    this.playerHP = 3;
    this.isUpDown = false;
    console.log("GameScene initialized with data:", data);
    if (data.map) {
      this.passedmap = data.map;
    }
  }

  create() {
    /*
    this.map = this.make.tilemap({
      key: "platformer-level-1",
      tileWidth: 18,
      tileHeight: 18,
      width: 100,
      height: 40,
    });
    */

    this.map = this.make.tilemap(this.passedmap);

    this
    /*
    const tileset = this.map.addTilesetImage(
      "kenny_tilemap_packed",
      "tilemap_tiles",
    )!;
    */

    const tileset = this.map.addTilesetImage(
      "pewterPlatformerTilesetExtended",
      "tileset",
      16,
      16,
      0,
      0,
    )!;

    // Create ground and background layer
    this.backgroundLayer = this.map.createLayer(
      "Background_Layer",
      tileset,
      0,
      0,
    )!;

    this.groundLayer = this.map.createLayer(
      "Ground_Layer", 
      tileset,
      0,
      0,
    )!;

    if (!this.groundLayer) {
        console.error('GROUND LAYER FAILED TO CREATE!');
        console.log('Available layers:', this.map.layers.map(l => l.name));
        return; // Stop execution
    }

    // Gives everything in the ground layer collision except empty tiles
    this.groundLayer.setCollisionByExclusion([-1]);

    if (this.groundLayer.layer.data[19]) { // Check bottom row
      console.log('Bottom row tile data:', this.groundLayer.layer.data[19].slice(0, 5)); // First 5 tiles
    }

    console.log('Checking tile collision after setting...');
    const testTile = this.groundLayer.getTileAt(10, 15); // Check a tile in the ground area
    if (testTile) {
      console.log('Test tile ID:', testTile.index, 'Collides:', testTile.collides);
    }

    console.log('Ground layer exists:', !!this.groundLayer);
    console.log('Ground layer data:', this.groundLayer.layer.data);
    console.log('Map layers:', this.map.layers.map(layer => layer.name));



    this.physics.world.setBounds(
      0,
      0,
      this.map.widthInPixels,
      this.map.heightInPixels,
    );
    this.physics.world.gravity.y = WORLD_GRAVITY_Y;

    /*
    //Not actually coins but whatever
    const coins = this.map.createFromObjects("Objects", {
      name: "coin",
      key: "tilemap_sheet",
      frame: 190,
    });
    this.physics.world.enable(coins, Phaser.Physics.Arcade.STATIC_BODY);
    this.coinGroup = this.add.group(coins);
    */

    /*
    this.player = this.physics.add.sprite(
      30,
      630,
      "platformer_characters",
      "tile_0000.png",
    ) as PlayerSprite;
    */

    this.player = this.physics.add.sprite(100, 150, 'spritesheet', 14) as PlayerSprite;
    configurePlayerSprite(this.player);
    this.player.isFalling = false;

    this.playerController = new PlayerController(this, this.player, {
      onJump: () => this.startJumpVFX(),
      onWalk: () => this.startWalkingVFX(),
      onStopWalking: () => this.vfx.walking?.stop(),
    });

    // this.cameras.main.centerOn(this.player.x, this.player.y);
    console.log('Player created at:', this.player.x, this.player.y);
    console.log('Player visible:', this.player.visible);
    console.log('Map height:', this.map.heightInPixels);
    console.log('Camera bounds:', this.cameras.main.getBounds());
    
    this.cameras.main
      .setBounds(0, 0, this.map.widthInPixels, this.map.heightInPixels)
      .startFollow(this.player, true, 0.25, 0.25)
      .setDeadzone(50, 50)
      .setZoom(2.25);

    this.cameras.main.useBounds = true;

    console.log('Camera scroll:', this.cameras.main.scrollX, this.cameras.main.scrollY);
    console.log('Camera zoom:', this.cameras.main.zoom);

    this.physics.add.collider(this.player, this.groundLayer);


    /* coin collision
    this.physics.add.overlap(this.player, this.coinGroup, (_obj1, obj2) => {
      obj2.destroy();
      this.sound.play("partCollect");
      this.collectedItems++;
      this.partCountText.setText(
        `Parts Collected: ${this.collectedItems} / 10`,
      );
    });
    */

    //Debug Key bound to G (handled in EditorScene.toggleDebugOverlay)

    //Gravity switch
    //this.input.keyboard!.on("keydown-G", () => this.toggleGravity(), this);

    /*
    //Dust particles while walking/Jumping
    this.vfx.walking = this.add.particles(0, 0, "kenny-particles", {
      frame: ["dirt_01.png"],
      //random: true,
      scale: { start: 0.03, end: 0.02 },
      maxAliveParticles: 8,
      lifespan: 350,
      alpha: { start: 1, end: 0.1 },
    });
    this.vfx.jump = this.add.particles(0, 0, "kenny-particles", {
      frame: ["dirt_02.png"],
      //random: true,
      scale: { start: 0.03, end: 0.2 },
      maxAliveParticles: 20,
      lifespan: 350,
      alpha: { start: 1, end: 0.1 },
    });
    this.vfx.walking.stop();
    this.vfx.jump.stop();
    */

    // DEBUG: Check camera
    //console.log('Camera following:', this.cameras.main.followTarget);
    console.log('Player depth:', this.player.depth);

    /* sound
    if (!this.sound.get("bgm")?.isPlaying)
      this.sound.play("bgm", { loop: true, volume: 0.0 });
    */
    
    /*
    //Parallax background
    this.background = this.add
      .tileSprite(
        0,
        0,
        this.map.widthInPixels,
        this.map.heightInPixels,
        "background",
      )
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(-90)
      .setScale(5);
    this.midground = this.add
      .tileSprite(
        0,
        0,
        this.map.widthInPixels,
        this.map.heightInPixels,
        "buildings",
      )
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(-89)
      .setScale(5);
      */

    this.coinText = this.add
      .text(16, 16, "Coins: 0", { fontSize: "18px", color: "#FFD700", stroke: "#000000", strokeThickness: 4 })
      .setDepth(99)
      .setScrollFactor(0);

    this.hpText = this.add
      .text(16, 42, "HP: 3", { fontSize: "18px", color: "#FF4444", stroke: "#000000", strokeThickness: 4 })
      .setDepth(99)
      .setScrollFactor(0);

    // editor button
    this.createEditorButton();
  }

  update(_time: number, delta: number) {
    this.playerController.update(delta);

    // Reset if fallen off the world
    if (this.player.y > this.map.heightInPixels + 100) {
      this.player.setPosition(100, 150);
      this.playerController.reset();
    }

    // update the edit button's position to the camera
    if (this.editorButton) {
      const cam = this.cameras.main;
      this.editorButton.x = cam.worldView.x + cam.worldView.width - 550;
      this.editorButton.y = cam.worldView.y + 250;
    }
  }

  private startWalkingVFX() {
    if (!this.vfx.walking) return;
    const { x, y } = this.getPlayerFootPos();
    this.vfx.walking.startFollow(this.player, x, y, false);
    this.vfx.walking.setParticleSpeed(this.particleVelocity, 0);

    if (this.player.body.blocked.down) {
      this.vfx.walking.start();
    }
    
  }

  private startJumpVFX() {
    if (!this.vfx.jump) return;
    const { x, y } = this.getPlayerFootPos();
    this.vfx.jump.startFollow(this.player, x, y, false);
    this.vfx.jump.emitParticle(10);
  }

  private getPlayerFootPos() {
    const x = this.player.displayWidth / 2 - 15;
    const y = this.player.flipY
      ? this.player.displayHeight / 2 - 25
      : this.player.displayHeight / 2 - 5;
    return { x, y };
  }


  // Editor button
  private createEditorButton() {

    const button = this.add.text(100, 100, 'Play', {
      fontSize:'24px',
      color: '#ffffff',
      backgroundColor: '#1a1a1a',
      padding: { x: 15, y: 10 },
    })
    .setDepth(100)
    .setInteractive()
    .on('pointerdown', () => {
      console.log('Editor button clicked!');
      this.scene.start('editorScene');
    })
    .on('pointerover', () => {
      button.setStyle({ backgroundColor: '#127803' });
    })
    .on('pointerout', () => {
      button.setStyle({ backgroundColor: '#1a1a1a' });
    });
    
    this.editorButton = button;
  }

  toggleGravity() {
    this.physics.world.gravity.y *= -1;
    this.player.flipY = !this.player.flipY;
    this.isUpDown = !this.isUpDown;
  }

  zoomMap(zoomLevel: number) {
    const clampedZoom = Phaser.Math.Clamp(zoomLevel, 0, 10);
    this.gameScale = clampedZoom; // Store the zoom level
    this.cameras.main.setZoom(clampedZoom);
    return `Game is now zoomed to level ${clampedZoom}`;
  }
}
