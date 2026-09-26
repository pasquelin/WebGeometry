import type { Object3D } from '../../../../sdk-core/src/world/object/object3d.ts';
import type { RenderBackend } from '../../backend/types.ts';
import type { GraphSurface } from '../../host/graph/surface.ts';
import type { GraphTexture } from '../../host/graph/texture.ts';
import { tableRankOf } from '../../host/prepared/materials.ts';
import { materialTextures, meshes } from '../../scene/meshes.ts';
import { EngineError, alphaModeOf } from '../../../../sdk-core/src/index.ts';
import {
  invalid,
  read,
  validate,
  write,
  type SceneMaterial,
  type SceneMaterialPatch,
} from './materialValues.ts';

export type { SceneMaterial, SceneMaterialPatch } from './materialValues.ts';

type Inputs = {
  check: () => void;
  /** The scene the session draws: its prepared surfaces are the scene's materials. */
  source: Object3D;
  backends: RenderBackend[];
  active: () => RenderBackend;
};

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
  /** Built at the first call, not at open: most pages never ask. Before any write, so the values
   *  it keeps as imported are the file's. */
  let held: ReturnType<typeof index> | undefined;
  const index = () => {
    const worn = new Map<number, Set<GraphSurface>>();
    const wearers = new Map<GraphTexture, Set<number>>();
    for (const mesh of meshes(source))
      for (const surface of [mesh.material as GraphSurface | GraphSurface[]].flat()) {
        const rank = tableRankOf(surface);
        if (rank === undefined) continue;
        worn.set(rank, (worn.get(rank) ?? new Set()).add(surface));
        for (const texture of materialTextures(surface))
          wearers.set(texture, (wearers.get(texture) ?? new Set()).add(rank));
      }
    const surfaces = new Map([...worn].map(([rank, set]) => [rank, [...set]]));
    const ranks = [...surfaces.keys()].sort((a, b) => a - b);
    // What the scene file carried: a page resets a material from it.
    const imported = ranks.map((rank) => read(rank, surfaces.get(rank)![0]));
    return { surfaces, wearers, ranks, imported };
  };
  const scene = () => (held ??= index());
  const required = (id: string) => {
    const rank = Number(id);
    // An id is the rank as listed: '', ' 1' or '1.0' would name a rank by accident.
    const worn = String(rank) === id ? scene().surfaces.get(rank) : undefined;
    if (!worn) throw new EngineError('UNKNOWN_MATERIAL', `the scene has no material ${id}`, { id });
    return { rank, worn };
  };
  return {
    /** The scene's materials as they are now, in table order; each a detached copy. */
    materials(): SceneMaterial[] {
      check();
      const { ranks, surfaces } = scene();
      return ranks.map((rank) => read(rank, surfaces.get(rank)![0]));
    },
    /** One material as it is now, a detached copy; an unknown id is refused by name. */
    material(id: string): SceneMaterial {
      check();
      const { rank, worn } = required(id);
      return read(rank, worn[0]);
    },
    /** The materials as the scene file carried them, whatever was set since: detached copies. */
    importedMaterials(): SceneMaterial[] {
      check();
      return structuredClone(scene().imported);
    },
    /**
     * Sets a material's values live, from the next frame; every check runs before any write.
     * False when an engine of the session cannot take it in place, and only a new session will.
     */
    setMaterial(id: string, patch: SceneMaterialPatch) {
      check();
      const { rank, worn } = required(id);
      validate(rank, patch);
      const from = alphaModeOf(worn[0]);
      // A masked material cut at zero is drawn as an opaque one.
      const to = from === 'mask' && patch.alphaCutoff === 0 ? 'opaque' : (patch.alphaMode ?? from);
      if (to !== from)
        throw new EngineError(
          'MATERIAL_CLASS_CHANGE',
          `material ${id} would move from ${from} to ${to}: its draw class is fixed at open`,
          { id, from, to },
        );
      if (patch.tiling) {
        const textures = worn.flatMap((surface) => [...materialTextures(surface)]);
        if (!textures.length) throw invalid(rank, 'tiling', patch.tiling);
        const { wearers } = scene();
        const shared = textures.find((texture) => wearers.get(texture)!.size > 1);
        if (shared)
          throw new EngineError(
            'MATERIAL_TEXTURE_SHARED',
            `material ${id} shares its map ${shared.name} with another material: tiling it would tile both`,
            { id, texture: shared.name, materials: [...wearers.get(shared)!].map(String) },
          );
      }
      const engine = active();
      if (!engine.refreshMaterials)
        throw new EngineError(
          'UNSUPPORTED_SCENE_UPDATE',
          `${engine.id} does not repaint materials in place`,
          { id },
        );
      for (const surface of worn) write(surface, patch);
      // An engine that cannot reread its surfaces has not taken the change (`setClearColor`).
      return backends.every(
        (backend) => !!backend.refreshMaterials && backend.refreshMaterials(true) !== false,
      );
    },
  };
}
