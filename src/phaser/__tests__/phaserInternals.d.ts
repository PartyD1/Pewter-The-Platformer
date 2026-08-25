/**
 * Phaser ships its Arcade internals as untyped CommonJS. The jump-solver
 * engine test imports `SeparateTile` directly so it can validate the solver
 * against the engine's genuine least-penetration logic without booting a
 * browser; this declares just enough of its shape to keep tsc quiet.
 */
declare module "phaser/src/physics/arcade/tilemap/SeparateTile.js" {
  interface TileWorldRect {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }

  /**
   * Separates a body from a tile, mutating the body in place. Returns true
   * if any separation occurred.
   */
  const SeparateTile: (
    index: number,
    body: unknown,
    tile: unknown,
    tileWorldRect: TileWorldRect,
    tilemapLayer: unknown,
    tileBias: number,
    isLayer: boolean,
  ) => boolean;

  export default SeparateTile;
}
