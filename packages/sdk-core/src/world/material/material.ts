import type { PhysicsMaterialPreset } from '../../physics/options.ts';
import { alphaModeOf, type Material as EngineMaterial } from '../../contracts/material.ts';
import { Color, type ColorInput } from '../math/color.ts';
import { listen } from '../math/observed.ts';
import type { Blending, Side } from '../constants/index.ts';

/** What a page may pass to a material member; every field is optional. */
export interface MaterialParameters {
  /** The base colour. */
  color?: ColorInput;
  /** A colour the surface gives off by itself, even in the dark. */
  emissive?: ColorInput;
  /** How strongly the surface glows. */
  emissiveIntensity?: number;
  /** How much the surface is metal: 0 is not at all, 1 is fully. */
  metalness?: number;
  /** How rough the surface is: 0 is a mirror, 1 is fully matte. */
  roughness?: number;
  /** How small and bright the shiny spot is. */
  shininess?: number;
  /** How opaque the surface is: 1 hides what is behind, 0 shows it all. */
  opacity?: number;
  /** Whether `opacity` lets what is behind show through. */
  transparent?: boolean;
  /** Which faces are drawn: the front, the back or both. */
  side?: Side;
  /** How the surface mixes with what is behind it. */
  blending?: Blending;
  /** Pixels less opaque than this are not drawn at all: cut-out leaves and fences. */
  alphaTest?: number;
  /** How much light passes through, like glass: 0 to 1. */
  transmission?: number;
  /** How much light bends going in: 1.5 for glass, 1.33 for water. */
  ior?: number;
  /** How thick a see-through surface is. */
  thickness?: number;
  /** A clear varnish on top: 0 to 1. */
  clearcoat?: number;
  /** How rough the varnish is. */
  clearcoatRoughness?: number;
  /** A soft glow at grazing angles, like velvet. */
  sheen?: number;
  /** Rainbow colours that change with the angle, like a soap bubble. */
  iridescence?: number;
  /** Draws only the edges of the triangles. */
  wireframe?: boolean;
  /** Gives each triangle one flat shade, showing its facets. */
  flatShading?: boolean;
  /** Size of a dot, for the points material. */
  size?: number;
  /** Whether dots and sprites get smaller with distance. */
  sizeAttenuation?: boolean;
  /** How far a sprite's picture is turned in the image, in radians, counter-clockwise. */ rotation?: number;
  /** Width of a line in CSS pixels, the same at every distance. */
  linewidth?: number;
  /** Length of a dash, in world units along the line. */
  dashSize?: number;
  /** Length of the gap between two dashes, in world units along the line. */
  gapSize?: number;
  /** How much the distance along a dashed line is stretched: 2 draws dashes and gaps half as long. */
  scale?: number;
  /** Whether the geometry's per-vertex `color` tints the surface. */
  vertexColors?: boolean;
  /** Whether the surface writes its depth, hiding what is drawn after it. */
  depthWrite?: boolean;
  /** Whether the surface hides behind what is already closer. */ depthTest?: boolean;
  /** Whether a see-through (`transparent`) surface still casts a shadow, paler the more see-through it is. @defaultValue false */ transparentShadow?: boolean;
  /** The matter of a body wearing it: density, friction, restitution. */ physics?: PhysicsMaterialPreset;
  /** kg/m³, times the volume for the mass. @defaultValue 1000 */ density?: number;
  /** How much a body grips, 0 and up. @defaultValue 0.5 */ friction?: number;
  /** How much a body bounces, 0 to 1. @defaultValue 0 */ restitution?: number;
  [param: string]: unknown;
}

/** The fields whose value is a colour: written through `Color`, whatever the page passes. */
const COLOURS = new Set(['color', 'emissive', 'specular', 'sheenColor', 'attenuationColor']);
/** The fields that are a material's bookkeeping, never one of its parameters. */
export const MATERIAL_BOOKKEEPING: ReadonlySet<string> = new Set([
  'isMaterial',
  'version',
  '_listeners',
  'heard',
]);

/**
 * The matter alone: the parameters of one material kind. The engine lights every kind with its
 * one surface model (`contracts/material.ts`); `surface()` is how a kind reads in that model. Any
 * write — a field, a colour, `needsUpdate` — reaches the meshes that wear it.
 */
export class Material {
  /** Always `true`: tells a material apart from anything else. */
  readonly isMaterial = true as const;
  /** The base colour; change it in place with `set`. */
  color = new Color(0xffffff);
  /** The colour the surface gives off by itself. */
  emissive = new Color(0x000000);
  /** How strongly the surface glows. */
  emissiveIntensity = 1;
  /** How much the surface is metal, 0 to 1. */
  metalness = 0;
  /** How rough the surface is, 0 (mirror) to 1 (matte). */
  roughness = 1;
  /** How opaque the surface is, 0 to 1. */
  opacity = 1;
  /** Whether `opacity` lets what is behind show through. */
  transparent = false;
  /** Which faces are drawn: `'front'`, `'back'` or `'double'`. */
  side: Side = 'front';
  /** How the surface mixes with what is behind it. */
  blending: Blending = 'normal';
  /** Pixels less opaque than this are dropped. */
  alphaTest = 0;
  /** Whether the geometry's per-vertex colours tint the surface. */
  vertexColors = false;
  /** Whether the surface writes its depth. */
  depthWrite = true;
  /** Whether the surface hides behind closer things. */ depthTest = true;
  /** Whether a see-through (`transparent`) surface still casts a shadow, paler the more see-through it is. */ transparentShadow = false;
  /** Physics matter preset of the bodies wearing it. */ declare physics?: PhysicsMaterialPreset;
  /** kg/m³, for a body's mass. */ declare density?: number;
  /** Physics friction. */ declare friction?: number;
  /** Physics restitution. */ declare restitution?: number;
  /** Bumped by every write: what the world compares to repaint. */
  version = 0;
  /** Who wears this material: every mesh holding it hears its writes. */
  readonly _listeners = new Set<() => void>();
  [param: string]: unknown;
  /** Tells every wearer this material changed. */
  private readonly heard = () => {
    this.version++;
    for (const listener of this._listeners) listener();
  };

  /** The kind the material was made as: `'meshStandard'`, `'meshBasic'`… */
  readonly kind: string;
  constructor(
    kind: string,
    parameters: MaterialParameters = {},
    defaults: Partial<MaterialParameters> = {},
  ) {
    this.kind = kind;
    const changed = this.heard;
    listen(this.color, changed);
    listen(this.emissive, changed);
    for (const [key, value] of Object.entries({ ...defaults, ...parameters }))
      if (value !== undefined) this.assign(key, value);
    // Every field written from here on is a change the meshes wearing it must see.
    return new Proxy(this, {
      set(target, key, value) {
        if (typeof key === 'string' && key !== 'version') target.assign(key, value);
        else Reflect.set(target, key, value);
        if (key !== 'version') changed();
        return true;
      },
    });
  }
  private assign(key: string, value: unknown) {
    if (COLOURS.has(key) && !(value instanceof Color)) {
      const current = this[key];
      if (current instanceof Color) current.set(value as ColorInput);
      else this[key] = new Color(value as ColorInput);
    } else this[key] = value;
    // A texture this material samples is heard like the material itself.
    const sampled = value as { isTexture?: boolean; _listeners?: Set<() => void> } | null;
    if (sampled?.isTexture) sampled._listeners?.add(this.heard);
  }
  /** `material.needsUpdate = true`: the meshes wearing it are repainted. */
  set needsUpdate(_value: boolean) {}
  get needsUpdate() {
    return false;
  }
  /** The engine's physical surface record of this material (`contracts/material.ts`). A kind
   *  outside the physical family is drawn through the host family of its name, which the engine
   *  maps onto its one lighting model (`surfaceModel.ts`). */
  surface(): EngineMaterial {
    const emitted = this.emissive.toArray().map((c) => c * this.emissiveIntensity);
    return {
      baseColor: this.color.toArray(),
      emissive: emitted as [number, number, number],
      opacity: this.opacity,
      metalness: this.metalness,
      roughness: this.roughness,
      side: this.side,
      alphaMode: alphaModeOf(this),
      alphaCutoff: this.alphaTest,
    };
  }
  /** A new material of the same kind, with the same values. */
  clone() {
    const parameters: MaterialParameters = {};
    for (const [key, value] of Object.entries(this))
      if (key !== 'kind' && !MATERIAL_BOOKKEEPING.has(key))
        parameters[key] = value instanceof Color ? value.clone() : value;
    return new Material(this.kind, parameters);
  }
  /** Forgets the wearers: a disposed material repaints nobody. */
  dispose() {
    this._listeners.clear();
  }
}
