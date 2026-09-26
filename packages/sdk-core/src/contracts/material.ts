/**
 * The engine's material: the surface parameters the compiler imported from the source file, and
 * nothing else. No shader, no program hook, no rendering-library object — a host that wants to
 * repaint a primitive during the session sends these numbers and the engine applies them.
 *
 * Colours are linear, in `[0, 1]`. The names follow the glTF metallic-roughness model the
 * compiler imports, so a value read from a manifest crosses the contract unchanged.
 */

/** Which faces of a surface are drawn, the engine's own enum, compared everywhere downstream. */
export type Side = 'front' | 'back' | 'double';

/** How the alpha channel of a surface is read: opaque ignores it, `mask` cuts at `alphaCutoff`,
 *  `blend` composes. A blended surface is never turned into a masked one inside the engine. */
export type AlphaMode = 'opaque' | 'mask' | 'blend';

/** The alpha mode a surface is drawn in, from its blend flag and cutoff: the one rule a host
 *  surface and the engine's material agree on. */
export const alphaModeOf = (surface: { transparent: boolean; alphaTest: number }): AlphaMode =>
  surface.transparent ? 'blend' : surface.alphaTest > 0 ? 'mask' : 'opaque';

/** One linear RGB colour, `[0, 1]` per channel. */
export type LinearRgb = readonly [number, number, number];

/** Surface parameters of one primitive, as the engine holds them. */
export interface Material {
  /** The base colour, linear. */
  baseColor: LinearRgb;
  /** Base-colour alpha, `1` for a surface that hides what is behind it. */
  opacity: number;
  /** How metallic, 0 to 1. */
  metalness: number;
  /** How rough, 0 to 1. */
  roughness: number;
  /** The colour it gives off. */
  emissive: LinearRgb;
  /** Which faces are drawn. */
  side: Side;
  /** Opaque, cut out, or blended. */
  alphaMode: AlphaMode;
  /** Alpha below which a masked surface discards the pixel; ignored by the other modes. */
  alphaCutoff: number;
}
