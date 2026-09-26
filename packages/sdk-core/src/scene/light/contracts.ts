/**
 * A scene light, version 2. Units are radiometric and linear (P1): `color` is a linear colour and
 * `intensity` a strictly positive radiometric intensity — a radiance for a `rect`. Four kinds,
 * and nothing else makes light in this engine (P6):
 * - `point`: a position and a range in metres beyond which it lights nothing;
 * - `spot`: the same plus a direction and a cone half-angle in radians;
 * - `directional`: the sun or an overcast sky — a propagation direction, no position and
 *   no range, the same irradiance everywhere, and clipmap shadows that follow the camera;
 * - `rect`: a one-sided rectangle of `size` metres centred on `position`, emitting along
 *   `direction`, its width along `right`; no cast shadow (`packages/sdk-browser/src/lighting/direct/rectLightWgsl.ts`).
 *
 * Fields a kind does not use are rejected at validation: a directional light with
 * a position would be a promise the engine would not keep.
 */
export interface SceneLight {
  /** The light's name. */ id: string;
  /** Point, spot, sun or rectangle. */ kind: 'point' | 'spot' | 'directional' | 'rect';
  /** Point and spot only: the point the light comes from, in metres. */
  position?: [number, number, number];
  /** Spot: the cone axis. Directional: the propagation direction (from the sun toward the
   *  ground). Rect: the normal of its emitting face. */
  direction?: [number, number, number];
  /** Its colour, linear RGB. */ color: [number, number, number];
  /** How strong it is. */ intensity: number;
  /** Point, spot and rect: the range in metres, where energy vanishes exactly. */
  range?: number;
  /** A spot's opening. */ coneAngle?: number;
  /** Spot only: the share of the cone, from its edge inward, over which the light fades in
   *  `[0, 1]`; without it the edge softens over `spotEdgeSoftness`. */
  penumbra?: number;
  /**
   * Point and spot only: the radius, in metres, of the envelope that holds the source.
   * A real light is always housed in something — lantern glass, reflector, shade
   * — and that envelope is geometry like any other: without this field, it enters its own
   * light's shadow map and turns it off. Declared, it becomes the near plane of that map,
   * so nothing that sits closer than this radius from the source casts a shadow there. It is a
   * property of the light, never an object name or a material type: the engine only knows
   * surfaces. Strictly positive and strictly less than the range; if absent, nothing changes.
   */
  emitterRadius?: number;
  /** Rect only: the unit axis its width runs along, perpendicular to `direction`. */
  right?: [number, number, number];
  /** Rect only: its width and height, in metres. */
  size?: [number, number];
  /** Whether it casts shadows. */ castsShadow: boolean;
}
/** Exposure, display curve and the irradiance from every direction (`../core/environment.ts`). */
export type { SceneEnvironment } from '../core/environment.ts';
/** The version of the light contract this engine reads. */ export const SCENE_LIGHT_VERSION = 2;
/**
 * What the host asks to see. `lit` is real lighting and that alone; `unlit` is the raw-albedo
 * diagnostic view — material colour as-is, with no light, no ambient and
 * no emission — for geometry benches that compare images pixel-exact. `auto`, the
 * default, yields `unlit` as long as no light is declared and `lit` as soon as there is one.
 *
 * `bounce` is the third diagnostic view: indirect irradiance alone, multiplied by
 * exposure and output as linear values without ACES or sRGB. This is what the harness compares to
 * the compiler oracle; it is not an image to look at, and it is black without a rigged bounce.
 */
export type SceneLightingView = 'auto' | 'lit' | 'unlit' | 'bounce';
/**
 * Published settings of direct lighting. These are named product choices, not buried
 * constants: every runtime bound rereads them, and the diagnostic publishes them as-is.
 */
export const LIGHT_SETTINGS = {
  /**
   * Lights a screen tile's list holds, in each of its two depth slices: its memory is this, per
   * tile, whatever the scene holds. A tile more lights reach keeps no list and walks every light
   * of the scene — those that miss it add an exact zero —, so no light is ever dropped (X2).
   */
  tileLights: 64,
  /** Side in pixels of a screen tile of the light list. */
  tileSize: 16,
  /**
   * Lights shaded in full — shadow read included — per pixel of a MOVING image (X2): the
   * others are weighed without their shadow, and the shaded ones are drawn in proportion, so
   * the estimate is unbiased and temporal antialiasing averages it. A still image shades
   * every light of its tile and converges to the exact sum; there, this number plays no part.
   */
  samplesPerPixel: 4,
  /**
   * Shadow pages one GPU batch draws: the size of the per-batch buffers, never a limit on a frame.
   * A frame draws every page it marks, in as many batches as that takes.
   */
  shadowPagesPerBatch: 24,
  /**
   * Side of a shadow page, in texels: the unit of the physical pool, of the virtual maps and of
   * invalidation. A moving object only stales the pages its projected box covers.
   */
  shadowPage: 128,
  /** Side of a lamp face's finest mip, in texels: 32 × 32 pages of 128 (the pool: `shadowPoolSide`). */
  lampFaceSize: 4096,
  /** Virtual pages the shading may request per frame; the rest ask again the next frame. */
  shadowRequestCap: 4096,
  /** PCF taps per pixel and per shadow light (X2). */
  pcfTaps: 16,
  /** Width of the softened edge of a spot cone, in cosine units: against staircasing. */
  spotEdgeSoftness: 0.02,
  /**
   * Clipmap levels of a directional light. Level `L` has texels of `2^L` metres, and a pixel
   * reads the level whose texel is at most its own footprint: sixteen levels cover a far/near
   * ratio of 2^15. Beyond the last level, the far shadow takes over.
   */
  sunLevels: 16,
  /**
   * Pages per side of a clipmap level's extent around the camera. It is a capacity, not a
   * tuning: every pixel reads its own density while `height / tan(halfFovY)` stays within
   * `sunLevelPages · shadowPage / 2` = 4096 (a 4K canvas at a 55° vertical field); beyond, the
   * outer pixels read the next level, at half the density.
   */
  sunLevelPages: 64,
  /**
   * Offset of the far-shadow ray origin along the normal, in metres. It only
   * serves to leave the lit surface's plane; the real remedy against self-shadowing is the
   * start along the ray, below.
   */
  sunFarShadowOffsetMetres: 0.05,
  /**
   * Start of the far-shadow ray along its own direction, in proxy cells. The lit
   * point comes from the fine geometry, the occluder from the coarse proxy: where the proxy
   * sits above the real surface, a ray started at zero would hit the surface it lights.
   * A proxy cell is the scale below which the proxy says nothing; starting from there
   * skips that false contact without inventing a shadow. The consequence is named: an occluder
   * closer than one cell along the ray carries no far shadow, and that one stays with the clipmap levels.
   */
  sunFarShadowStartCells: 1,
  /** Near plane of a slice: a fraction of the range, never less than this floor. */
  shadowNearFraction: 1 / 200,
  /** Nearest shadow distance. */ shadowNearMin: 0.05,
  /**
   * Offset of the sample point along the normal, in texels of the map read: half a texel, the
   * margin for what is not the receiver's plane — its curvature within a texel, the rounding of
   * both depths. The receiver's slope is covered by a depth margin over the PCF's reach, and
   * past 45° by a further offset, in the same texels (`shadowDepthMargin`, `shadowNormalTexels`):
   * no bias is a length of the scene.
   */
  shadowNormalOffsetTexels: 0.5,
} as const;
/**
 * Shadow slices the atlas addresses, under the page table's own rules (#818) — never a limit on
 * the lights: a shadow-casting light beyond them lights without a shadow, and the frame counts it
 * (`shadowCastersUnsliced`).
 */
export const MAX_SHADOW_SLICES = 64;

/** Faces of a point light's slice: six. */
export const POINT_FACES = 6;
/** Floats of a light in the GPU buffer: five `vec4f`. */
export const SCENE_LIGHT_FLOATS = 20;
/** Light-buffer header: count, then three reserved words. */
export const SCENE_LIGHT_HEADER_FLOATS = 4;
/** Rank of a light kind in the GPU buffer: the shader refers to it by this number, not by name.
 *  @property point - A bulb. @property spot - A torch. @property directional - The sun.
 *  @property rect - A glowing rectangle. */
export const LIGHT_KIND = { point: 0, spot: 1, directional: 2, rect: 3 } as const;
/** Axis of a light that has one — spot, directional, rect —, normalised by the contract, which
 *  rejects a light of those kinds without one: reading it here assumes nothing more. */
export const lightDirection = (light: SceneLight) => light.direction as [number, number, number];
/** What the scheduler knows of the view: a camera, not a matrix, to stay without a dependency. */
export interface ShadowViewpoint {
  /** Where the viewpoint stands. */ position: readonly [number, number, number];
  /** Which way it looks. */ forward: readonly [number, number, number];
  /** Half its vertical opening. */ halfFovY: number;
  /** Width over height. */ aspect: number;
  /** Nearest distance. */ near: number;
  /** Farthest distance. */ far: number;
  /** World size of one pixel at the near plane: the finest footprint any pixel of the view has. */
  pixelNear: number;
}
/** The eleven numbers of a view, in order: position, axis, half-field, aspect, near, far, and
 *  the pixel's footprint at the near plane. */
export const VIEW_NUMBERS = 11;
export function writeView(view: ShadowViewpoint, out: Float64Array) {
  out.set(view.position);
  out.set(view.forward, 3);
  out[6] = view.halfFovY;
  out[7] = view.aspect;
  out[8] = view.near;
  out[9] = view.far;
  out[10] = view.pixelNear;
  return out;
}
