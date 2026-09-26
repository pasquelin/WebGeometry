import type { ClusterDrawMesh, HostAttributes, WholeMesh } from '../../cluster/batchMesh.ts';
import { clusterMaterialReason } from './compatibility.ts';
import { refuseCluster as refuse } from './refusal.ts';
import type { Material } from './materialBinding.ts';
import { physicalFeaturesLost } from '../../scene/physicalMaterialGate.ts';

/** Hears the physical `features` a surface is drawn without on WebGL2 (`physicalFeaturesLost`),
 *  at every frame that draws it: the hearer says each once (`noticeMaterialDegraded`). */
export type MaterialDegraded = (material: Material, features: readonly string[]) => void;

const validateMeshes = (
  meshes: readonly (ClusterDrawMesh | WholeMesh)[],
  seen: Map<Material, HostAttributes>,
  transmissive: boolean,
  degraded: MaterialDegraded | undefined,
) => {
  for (const mesh of meshes) {
    const { material } = mesh,
      attributes = mesh.geometry.attributes;
    if (Array.isArray(material)) refuse('material arrays are unsupported');
    const previous = seen.get(material);
    if (previous === attributes) continue;
    const reason = clusterMaterialReason(material, attributes, transmissive);
    if (reason) refuse(reason);
    if (previous) continue;
    seen.set(material, attributes);
    const lost = physicalFeaturesLost(material);
    if (lost) degraded?.(material, lost);
  }
};

/**
 * Refuses every mesh of the frame before any of them is submitted: no partial image. Only the
 * copies of the transmission pass may transmit; a page or a plain copy that does is refused. A
 * physical extension is no refusal: the surface is drawn without it and `degraded` hears it.
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
  degraded?: MaterialDegraded,
) {
  seen.clear();
  validateMeshes(meshes, seen, false, degraded);
  validateMeshes(wholeMeshes, seen, false, degraded);
  validateMeshes(copies.plain, seen, false, degraded);
  validateMeshes(copies.blended, seen, false, degraded);
  validateMeshes(copies.transmissive, seen, true, degraded);
}
