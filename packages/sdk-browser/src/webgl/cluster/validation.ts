import type { ClusterDrawMesh, HostAttributes, WholeMesh } from '../../cluster/batchMesh.ts';
import { clusterMaterialReason } from './compatibility.ts';
import { refuseCluster as refuse } from './refusal.ts';
import type { Material } from './materialBinding.ts';
import { physicalFeaturesLost } from '../../scene/physicalMaterialGate.ts';

/** Hears the physical `features` a surface is drawn without on WebGL2 (`physicalFeaturesLost`):
 *  the hearer says each once (`noticeMaterialDegraded`). */
export type MaterialDegraded = (material: Material, features: readonly string[]) => void;

/** What reads a drawn surface's lost physical features (`readDegraded`). */
export type ReadDegraded = (material: Material) => void;

/** Reads a drawn surface's lost features for `hear` once per version of the surface: a frame
 *  that draws it unchanged scans nothing. */
export function readDegraded(hear: MaterialDegraded): ReadDegraded {
  const read = new WeakMap<Material, number>();
  return (material: Material) => {
    if (read.get(material) === material.version) return;
    read.set(material, material.version);
    const lost = physicalFeaturesLost(material);
    if (lost) hear(material, lost);
  };
}

/**
 * Refuses every mesh of the frame before any of them is submitted: no partial image. Only the
 * copies of the transmission pass may transmit; a page or a plain copy that does is refused. A
 * physical extension is no refusal: the surface is drawn without it and `degraded` reads it.
 */
export function validateClusterMeshes(
  meshes: readonly ClusterDrawMesh[],
  wholeMeshes: readonly WholeMesh[],
  copies: {
    plain: readonly WholeMesh[];
    blended: readonly WholeMesh[];
    transmissive: readonly WholeMesh[];
  },
  seen: Map<Material, HostAttributes>,
  degraded?: ReadDegraded,
) {
  const validate = (drawn: readonly (ClusterDrawMesh | WholeMesh)[], transmissive: boolean) => {
    for (const mesh of drawn) {
      const { material } = mesh,
        attributes = mesh.geometry.attributes;
      if (Array.isArray(material)) refuse('material arrays are unsupported');
      const previous = seen.get(material);
      if (previous === attributes) continue;
      const reason = clusterMaterialReason(material, attributes, transmissive);
      if (reason) refuse(reason);
      if (previous) continue;
      seen.set(material, attributes);
      degraded?.(material);
    }
  };
  seen.clear();
  validate(meshes, false);
  validate(wholeMeshes, false);
  validate(copies.plain, false);
  validate(copies.blended, false);
  validate(copies.transmissive, true);
}
