import { EngineError, type AlphaMode, type Material } from '../../../../sdk-core/src/index.ts';
import type { Color } from '../../../../sdk-core/src/world/math/color.ts';
import type { Object3D } from '../../../../sdk-core/src/world/object/object3d.ts';
import type { RenderBackend } from '../../backend/types.ts';
import type { GraphSurface } from '../../host/graph/surface.ts';
import type { GraphTexture } from '../../host/graph/texture.ts';
import { tableRankOf } from '../../host/prepared/materials.ts';
import { materialTextures, meshes } from '../../scene/meshes.ts';
import { sideOf } from '../../scene/materialSide.ts';

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

type Inputs = {
  check: () => void;
  /** The scene the session draws: its prepared surfaces are the scene's materials. */
  source: Object3D;
  backends: RenderBackend[];
  active: () => RenderBackend;
};

/** The draw class a surface is drawn in: blended, cut out, or opaque. */
const classOf = (surface: GraphSurface): AlphaMode =>
  surface.transparent ? 'blend' : surface.alphaTest > 0 ? 'mask' : 'opaque';

const rgb = (color: Color, scale = 1) =>
  [color.r * scale, color.g * scale, color.b * scale] as [number, number, number];

function read(id: string, surface: GraphSurface): SceneMaterial {
  const emissive = surface.emissive as Color | undefined;
  const map = materialTextures(surface).next().value;
  return {
    id,
    name: surface.name,
    baseColor: rgb(surface.color as Color),
    opacity: surface.opacity,
    metalness: typeof surface.metalness === 'number' ? surface.metalness : 0,
    roughness: typeof surface.roughness === 'number' ? surface.roughness : 1,
    emissive: emissive
      ? rgb(emissive, (surface.emissiveIntensity as number | undefined) ?? 1)
      : [0, 0, 0],
    side: sideOf(surface),
    alphaMode: classOf(surface),
    alphaCutoff: surface.alphaTest,
    tiling: map ? [map.repeat.x, map.repeat.y] : null,
  };
}

const invalid = (id: string, field: string, value: unknown) =>
  new EngineError('INVALID_MATERIAL', `material ${id}: ${field} is out of its range`, {
    id,
    field,
    value,
  });

/** Every value of the patch in its range, or a named refusal before anything is written. */
function validate(id: string, patch: SceneMaterialPatch) {
  const unit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
  for (const field of ['opacity', 'metalness', 'roughness', 'alphaCutoff'] as const) {
    const value = patch[field];
    if (value !== undefined && !unit(value)) throw invalid(id, field, value);
  }
  if (patch.baseColor && !(patch.baseColor.length === 3 && patch.baseColor.every(unit)))
    throw invalid(id, 'baseColor', patch.baseColor);
  const glow = (n: number) => Number.isFinite(n) && n >= 0;
  if (patch.emissive && !(patch.emissive.length === 3 && patch.emissive.every(glow)))
    throw invalid(id, 'emissive', patch.emissive);
  const repeat = (n: number) => Number.isFinite(n) && n !== 0;
  if (patch.tiling && !(patch.tiling.length === 2 && patch.tiling.every(repeat)))
    throw invalid(id, 'tiling', patch.tiling);
}

/** Writes the patch into one surface in place and bumps its version: every reader takes it again
 *  at its next read, as a World's live edit does (`../core/worldSurface.ts`, #335). */
function write(surface: GraphSurface, patch: SceneMaterialPatch) {
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

/**
 * Public API of the scene's materials, the shape of the light API (`lightApi.ts`). A material is
 * one entry of the cache's material table, keyed by its rank there, never by a primitive: setting
 * it writes every surface the scene built from that entry — one per geometry variant — in place,
 * and the active engine reads them again at the next frame (`refreshMaterials`), no second upload
 * path and no new GPU memory. What would move it to another draw class, opaque, masked or
 * blended, is refused by name (`MATERIAL_CLASS_CHANGE`): the passes are laid out at open.
 */
export function createExplorerMaterialApi(inputs: Inputs) {
  const { check, source, backends, active } = inputs;
  const surfaces = new Map<string, GraphSurface[]>();
  const wearers = new Map<GraphTexture, Set<string>>();
  for (const mesh of meshes(source))
    for (const surface of [mesh.material as GraphSurface | GraphSurface[]].flat()) {
      const rank = tableRankOf(surface);
      if (rank === undefined) continue;
      const id = String(rank);
      const held = surfaces.get(id) ?? [];
      if (!held.includes(surface)) surfaces.set(id, [...held, surface]);
      for (const texture of materialTextures(surface))
        wearers.set(texture, (wearers.get(texture) ?? new Set()).add(id));
    }
  const ids = [...surfaces.keys()].sort((a, b) => Number(a) - Number(b));
  // What the scene file carried, read once at open: a page resets a material from it.
  const imported = new Map(ids.map((id) => [id, read(id, surfaces.get(id)![0])]));
  const copy = (material: SceneMaterial): SceneMaterial => ({
    ...material,
    baseColor: [...material.baseColor],
    emissive: [...material.emissive],
    tiling: material.tiling && [...material.tiling],
  });
  const required = (id: string) => {
    const held = surfaces.get(id);
    if (!held) throw new EngineError('UNKNOWN_MATERIAL', `the scene has no material ${id}`, { id });
    return held;
  };
  return {
    /** The scene's materials as they are now, in table order; each a detached copy. */
    materials(): SceneMaterial[] {
      check();
      return ids.map((id) => read(id, surfaces.get(id)![0]));
    },
    /** One material as it is now, a detached copy; an unknown id is refused by name. */
    material(id: string): SceneMaterial {
      check();
      return read(id, required(id)[0]);
    },
    /** The materials as the scene file carried them, whatever was set since: detached copies. */
    importedMaterials(): SceneMaterial[] {
      check();
      return ids.map((id) => copy(imported.get(id)!));
    },
    /** Sets a material's values live, from the next frame. Every check runs before any write. */
    setMaterial(id: string, patch: SceneMaterialPatch) {
      check();
      const held = required(id);
      validate(id, patch);
      const from = classOf(held[0]);
      const to = patch.alphaMode ?? from;
      if (to !== from || (to === 'mask' && patch.alphaCutoff === 0))
        throw new EngineError(
          'MATERIAL_CLASS_CHANGE',
          `material ${id} would move from ${from} to ${to === from ? 'opaque' : to}: its draw class is fixed at open`,
          { id, from, to },
        );
      if (patch.tiling) {
        const textures = held.flatMap((surface) => [...materialTextures(surface)]);
        if (!textures.length)
          throw new EngineError('INVALID_MATERIAL', `material ${id} has no map to tile`, { id });
        const shared = textures.find((texture) => wearers.get(texture)!.size > 1);
        if (shared)
          throw new EngineError(
            'MATERIAL_TEXTURE_SHARED',
            `material ${id} shares its map ${shared.name} with another material: tiling it would tile both`,
            { id, texture: shared.name, materials: [...wearers.get(shared)!] },
          );
      }
      const engine = active();
      if (!engine.refreshMaterials)
        throw new EngineError(
          'UNSUPPORTED_SCENE_UPDATE',
          `${engine.id} does not repaint materials in place`,
          { id },
        );
      for (const surface of held) write(surface, patch);
      for (const backend of backends) backend.refreshMaterials?.(true);
    },
  };
}
