/** The values of a scene material a page reads and sets, and how they cross a host surface
 *  (`materialApi.ts`). */
import { EngineError, type AlphaMode, type Material } from '../../../../sdk-core/src/index.ts';
import type { Color } from '../../../../sdk-core/src/world/math/color.ts';
import type { GraphSurface } from '../../host/graph/surface.ts';
import { materialTextures } from '../../scene/meshes.ts';
import { sideOf } from '../../scene/materialSide.ts';
import { importHostSurface } from '../../host/surfaceImport.ts';

/** A material of the scene as a page reads it: the engine's parameters, the id it is set by — its
 *  rank in the cache's material table — its name, and how many times its maps repeat across and
 *  up, `null` for a material without a map. */
export interface SceneMaterial extends Material {
  readonly id: string;
  name: string;
  tiling: readonly [number, number] | null;
}

/** What `setMaterial` writes live: the values the frame reads, nothing that rebuilds a pass. */
export type SceneMaterialPatch = Partial<
  Pick<
    SceneMaterial,
    'baseColor' | 'opacity' | 'metalness' | 'roughness' | 'emissive' | 'alphaMode' | 'alphaCutoff'
  > & { tiling: readonly [number, number] }
>;

/** The draw class a surface is drawn in: blended, cut out, or opaque. */
export const classOf = (surface: GraphSurface): AlphaMode =>
  surface.transparent ? 'blend' : surface.alphaTest > 0 ? 'mask' : 'opaque';

/** A material as the engine draws it now, read where every engine path reads a host surface
 *  (`importHostSurface`), so a family without metal or glow lists what is drawn. */
export function read(id: number, surface: GraphSurface): SceneMaterial {
  const drawn = importHostSurface(surface)!;
  const map = materialTextures(surface).next().value;
  return {
    id: String(id),
    name: surface.name,
    baseColor: drawn.baseColor,
    opacity: surface.opacity,
    metalness: drawn.metalness,
    roughness: drawn.roughness,
    emissive: drawn.emissive,
    side: sideOf(surface),
    alphaMode: classOf(surface),
    alphaCutoff: drawn.alphaTest,
    tiling: map ? [map.repeat.x, map.repeat.y] : null,
  };
}

export const invalid = (id: number, field: string, value: unknown) =>
  new EngineError('INVALID_MATERIAL', `material ${id}: ${field} is out of its range`, {
    id,
    field,
    value,
  });

/** Every value of the patch in its range, or a named refusal before anything is written. */
export function validate(id: number, patch: SceneMaterialPatch) {
  const unit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  for (const field of ['opacity', 'metalness', 'roughness', 'alphaCutoff'] as const) {
    const value = patch[field];
    if (value !== undefined && !unit(value)) throw invalid(id, field, value);
  }
  const vector = (
    field: 'baseColor' | 'emissive' | 'tiling',
    size: number,
    ok: (n: number) => boolean,
  ) => {
    const value = patch[field];
    if (value && !(value.length === size && value.every(ok))) throw invalid(id, field, value);
  };
  vector('baseColor', 3, unit);
  vector('emissive', 3, (n) => Number.isFinite(n) && n >= 0);
  vector('tiling', 2, (n) => Number.isFinite(n) && n !== 0);
}

/** Writes the patch into one surface in place and bumps its version: every reader takes it again
 *  at its next read, as a World's live edit does (`../core/worldSurface.ts`, #335). */
export function write(surface: GraphSurface, patch: SceneMaterialPatch) {
  if (patch.baseColor) (surface.color as Color).setRGB(...patch.baseColor);
  if (patch.opacity !== undefined) surface.opacity = patch.opacity;
  if (patch.metalness !== undefined && typeof surface.metalness === 'number')
    surface.metalness = patch.metalness;
  if (patch.roughness !== undefined && typeof surface.roughness === 'number')
    surface.roughness = patch.roughness;
  if (patch.emissive && surface.emissive) {
    (surface.emissive as Color).setRGB(...patch.emissive);
    surface.emissiveIntensity = 1;
  }
  // The cutoff of a masked surface only: written on another, it would move it into the masked class.
  if (patch.alphaCutoff !== undefined && classOf(surface) === 'mask')
    surface.alphaTest = patch.alphaCutoff;
  if (patch.tiling)
    for (const texture of materialTextures(surface)) texture.repeat.set(...patch.tiling);
  surface.needsUpdate = true;
}
