import {
  LIGHT_KIND,
  SCENE_LIGHT_FLOATS,
  SCENE_LIGHT_HEADER_FLOATS,
  type SceneLight,
} from './contracts.ts';

/** First float of light `slot` in the packed store. */
export const baseOf = (slot: number) => SCENE_LIGHT_HEADER_FLOATS + slot * SCENE_LIGHT_FLOATS;

/** Field of a light in the buffer, in floats from its base. Four `vec4f` per light. */
export const LIGHT_FIELD = {
  /** Where it stands. */
  position: 0,
  /** How far it reaches. */
  range: 3,
  /** Its colour. */
  color: 4,
  /** Its strength. */
  intensity: 7,
  /** Where it points. */
  direction: 8,
  /** Cosine of its cone. */
  cosCone: 11,
  /** Its kind. */
  kind: 12,
  /** Its shadow slot. */
  shadowSlice: 13,
  /** Whether it casts shadows. */
  castsShadow: 14,
  /** A spot's inner cone, where its penumbra starts: the cone's own edge when it has none. */
  cosInner: 15,
  /** A rectangle's half-width axis — `right` times half its width —, then half its height. */
  halfWidth: 16,
  /** Half a rectangle's height. */
  halfHeight: 19,
} as const;
/** A point tests no cone, and a spot without penumbra no inner cone: this cosine never bounds. */
const NO_CONE = -2;

function writeVector(packed: Float32Array, at: number, value: readonly number[]) {
  packed[at] = value[0];
  packed[at + 1] = value[1];
  packed[at + 2] = value[2];
}

/**
 * Writes the fields a host declares for one light at `base`. The shadow slice is not one: the
 * scheduler sets it. A directional has neither position nor range: its two fields stay zero,
 * and the shader never reads them — it branches on the kind first.
 */
export function writeLightFields(packed: Float32Array, base: number, light: SceneLight) {
  writeVector(packed, base + LIGHT_FIELD.position, light.position ?? [0, 0, 0]);
  packed[base + LIGHT_FIELD.range] = light.range ?? 0;
  writeVector(packed, base + LIGHT_FIELD.color, light.color);
  packed[base + LIGHT_FIELD.intensity] = light.intensity;
  writeVector(packed, base + LIGHT_FIELD.direction, light.direction ?? [0, -1, 0]);
  const spot = light.kind === 'spot';
  packed[base + LIGHT_FIELD.cosCone] = spot ? Math.cos(light.coneAngle!) : NO_CONE;
  packed[base + LIGHT_FIELD.kind] = LIGHT_KIND[light.kind];
  packed[base + LIGHT_FIELD.castsShadow] = light.castsShadow ? 1 : 0;
  packed[base + LIGHT_FIELD.cosInner] =
    spot && light.penumbra ? Math.cos(light.coneAngle! * (1 - light.penumbra)) : NO_CONE;
  const [width, height] = light.size ?? [0, 0];
  writeVector(
    packed,
    base + LIGHT_FIELD.halfWidth,
    (light.right ?? [0, 0, 0]).map((c) => (c * width) / 2),
  );
  packed[base + LIGHT_FIELD.halfHeight] = height / 2;
}
