/**
 * The host surfaces of the prepared scene, built from the material table under the rules the host
 * loader applied, so that the engine reads from them exactly what it read before
 * (`../surfaceImport.ts`, `../../scene/materialSide.ts`) and a host renderer draws them alike:
 *
 * - `unlit` is the host's basic surface, `physical` its physical one, anything else standard;
 * - a blended surface is transparent and writes no depth, a masked one cuts at `alphaTest`;
 * - the table entry already carries the tangent variant (`normalScaleY`); the variants a primitive
 *   adds — vertex colours, flat shading where it has no normal — are built per primitive kind;
 * - the physical extensions are applied under the parameter names the table writes them with.
 */
import type { TableMaterial, TableTextureSlot } from '../../../../sdk-core/src/index.ts';
import { Vector2 } from '../../../../sdk-core/src/world/math/vector2.ts';
import { GraphSurface } from '../graph/surface.ts';
import { type GraphTexture } from '../graph/texture.ts';
import { hostSide } from '../../scene/materialSide.ts';
import { HOST_COLOUR_SPACE_SRGB } from '../surfaceConstants.ts';
import { linearColour } from '../graph/surfaceFields.ts';

type Slot = (slot: TableTextureSlot, colorSpace?: string) => Promise<GraphTexture | null>;
type Params = Record<string, unknown>;

/** The extension maps that hold colour, and are read in sRGB. */
const COLOUR_MAPS = new Set(['sheenColorMap', 'specularColorMap']);
/** The extension factors that are colours. */
const COLOURS = new Set(['sheenColor', 'specularColor']);

const isSlot = (value: unknown): value is TableTextureSlot =>
  typeof value === 'object' && value !== null && 'texture' in value;

/** The variant of a surface a primitive asks for: what its geometry carries. */
export type SurfaceVariant = { vertexColors: boolean; flatShading: boolean };

function extensionParams(
  entry: TableMaterial,
  params: Params,
  assign: (name: string, slot: TableTextureSlot, colour?: boolean) => void,
) {
  for (const [name, value] of Object.entries(entry.extensions)) {
    if (isSlot(value)) assign(name, value, COLOUR_MAPS.has(name));
    else if (name === 'clearcoatNormalScale')
      params[name] = new Vector2(value as number, value as number);
    else if (COLOURS.has(name)) params[name] = linearColour(value as number[]);
    else params[name] = Array.isArray(value) ? [...value] : value;
  }
  // The host rebuilds the tangent frame from screen derivatives on geometry without tangents, and
  // turns the second clear-coat normal factor the way it turns the first.
  if (entry.kind === 'physical' && entry.derivativeTangents) {
    const scale = (params.clearcoatNormalScale as Vector2 | undefined) ?? new Vector2(1, 1);
    params.clearcoatNormalScale = scale.set(scale.x, -scale.y);
  }
}

async function build(entry: TableMaterial, variant: SurfaceVariant, slot: Slot) {
  const params: Params = { color: linearColour(entry.baseColor), opacity: entry.opacity };
  const pending: Promise<void>[] = [];
  const assign = (name: string, from: TableTextureSlot | null, colour = false) => {
    if (from)
      pending.push(
        slot(from, colour ? HOST_COLOUR_SPACE_SRGB : undefined).then((texture) => {
          if (texture) params[name] = texture;
        }),
      );
  };
  assign('map', entry.map, true);
  if (entry.kind !== 'unlit') {
    params.metalness = entry.metalness;
    params.roughness = entry.roughness;
    assign('metalnessMap', entry.metalnessMap);
    assign('roughnessMap', entry.roughnessMap);
    assign('normalMap', entry.normalMap);
    params.normalScale = new Vector2(entry.normalScale, entry.normalScaleY);
    assign('aoMap', entry.aoMap);
    params.aoMapIntensity = entry.aoIntensity;
    params.emissive = linearColour(entry.emissive);
    assign('emissiveMap', entry.emissiveMap, true);
    extensionParams(entry, params, assign);
  }
  if (entry.kind === 'physical') {
    params.transmission = entry.transmission;
    params.ior = entry.ior;
    params.thickness = entry.thickness;
    params.attenuationDistance = entry.attenuationDistance || Infinity;
    params.attenuationColor = linearColour(entry.attenuationColor);
  }
  if (entry.doubleSided) params.side = hostSide('double');
  params.transparent = entry.alphaMode === 'BLEND';
  if (entry.alphaMode === 'BLEND') params.depthWrite = false;
  if (entry.alphaMode === 'MASK') params.alphaTest = entry.alphaTest;
  if (variant.vertexColors) params.vertexColors = true;
  if (variant.flatShading) params.flatShading = true;
  await Promise.all(pending);
  const family =
    entry.kind === 'unlit' ? 'basic' : entry.kind === 'physical' ? 'physical' : 'standard';
  const material = new GraphSurface(family, params);
  if (entry.name) material.name = entry.name;
  return material;
}

/** The table rank each prepared surface was built from: the scene's own material id, which a
 *  page lists and sets by (`../../world/api/materialApi.ts`); a surface built elsewhere has none. */
const tableRanks = new WeakMap<GraphSurface, number>();
export const tableRankOf = (surface: GraphSurface) => tableRanks.get(surface);

/**
 * The surface of each table rank in each variant, built once and shared by every primitive that
 * wears it: a record the engine holds per surface is then held once per surface.
 */
export function preparedMaterials(materials: readonly TableMaterial[], slot: Slot) {
  const built = new Map<string, Promise<GraphSurface>>();
  return (rank: number, variant: SurfaceVariant) => {
    const key = `${rank}:${variant.vertexColors}:${variant.flatShading}`;
    let material = built.get(key);
    if (!material) {
      material = build(materials[rank], variant, slot).then((surface) => {
        tableRanks.set(surface, rank);
        return surface;
      });
      built.set(key, material);
    }
    return material;
  };
}
