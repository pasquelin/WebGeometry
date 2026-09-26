/**
 * Admission gate of a host surface, read once at import and never on a frame.
 *
 * It names what the autonomous programs cannot preserve before they submit a draw — a shader hook,
 * an unsupported blend state, a map the engine has no slot for, an attribute the pages cannot
 * carry. Every check is about the host declaration itself, read through the shapes of
 * `shadedMaterial.ts` and the named constants of `surfaceConstants.ts`; what the engine
 * computes with afterwards is the imported record of `surfaceImport.ts`.
 */

import type { HostAttribute, HostAttributes, HostMaterials } from './resources.ts';
import type { HostMap, HostShadedMaterial } from './shadedMaterial.ts';
import { blendingOf, blendingRefusal } from '../scene/materialBlending.ts';
import { readsOcclusion, unreadMapRefusal } from '../scene/surfaceModel.ts';
import { HOST_MAPPING_UV, HOST_NORMAL_MAP_TANGENT_SPACE } from './surfaceConstants.ts';
import { texelsReason } from '../visibility/types.ts';
import { declaresCompileHook } from './materialHook.ts';
import { isTransmissive } from '../visibility/shader/material.ts';

const textureReason = (texture: HostMap) => {
  if (!texture) return;
  if (!texture.image) return 'texture image is unavailable';
  const texels = texture.kind === 'texels' && texelsReason(texture);
  if (texels) return texels;
  if (texture.channel !== 0 && texture.channel !== 1)
    return `texture channel ${texture.channel} is unsupported`;
  if (texture.mapping !== HOST_MAPPING_UV) return 'non-UV texture mapping is unsupported';
};

/** An attribute the autonomous programs can bind on its own: the host declares it as a buffer of
 *  its own, not as one view interleaved into a shared one. */
const ownBuffer = (attribute: HostAttribute | undefined) => attribute?.kind === 'attribute';

/**
 * Names material input the autonomous WebGL2 program cannot preserve before it submits a draw.
 * A physical extension is not one: it is drawn without, by name (`physicalFeaturesLost`).
 * A transmissive physical material is accepted only where `transmissive` says the draw reads
 * the frozen backdrop: a scene copy of the transmission pass does, a paged cluster never does.
 */
export function clusterMaterialReason(
  material: HostMaterials,
  attributes: HostAttributes,
  transmissive = false,
) {
  if (Array.isArray(material)) return 'material arrays are unsupported';
  const host = material as HostShadedMaterial;
  // The draws' own refusal (`drawnBlending`): a mode admitted here is one every path draws.
  const refusal = blendingRefusal(blendingOf(host.blending), isTransmissive(material));
  if (refusal) return `material ${host.family}: ${refusal} (blending ${host.blending})`;
  if (
    host.alphaHash ||
    host.premultipliedAlpha ||
    host.alphaToCoverage ||
    host.clippingPlanes?.length
  )
    return `material ${host.family} uses an unsupported blend state`;
  if (!transmissive && isTransmissive(material))
    return 'a transmissive material is drawn as a scene copy, not as a paged cluster';
  if (
    host.envMap ||
    host.lightMap ||
    host.bumpMap ||
    host.displacementMap ||
    host.alphaMap ||
    host.wireframe ||
    host.stencilWrite
  )
    return `material ${host.family} uses an unsupported extension or raster state`;
  const unread = unreadMapRefusal(host);
  if (unread) return unread;
  if (host.normalMap && host.normalMapType !== HOST_NORMAL_MAP_TANGENT_SPACE)
    return 'object-space normal mapping is unsupported';
  if (declaresCompileHook(host)) return `material ${host.family} carries a shader hook`;
  if (!ownBuffer(attributes.position)) return 'position attribute is unsupported';
  // The same six maps the import reads, in the same order: a basic material declares none of the
  // lit ones, so the list is the host's own properties, not a second rule. An occlusion map its
  // model ignores asks for no UV.
  const maps = [
    host.map,
    host.metalnessMap,
    host.roughnessMap,
    host.normalMap,
    readsOcclusion(host) ? host.aoMap : undefined,
    host.emissiveMap,
  ];
  if (maps.some(Boolean) && !ownBuffer(attributes.uv))
    return 'textured material has no UV attribute';
  if (maps.some((texture) => texture?.channel === 1) && !ownBuffer(attributes.uv1))
    return 'texture channel 1 has no UV1 attribute';
  // Every family but the plain colour and the depth ramp shades by the normal: the lit ones, the
  // normal view, and the matcap, which reads its image by it.
  if (host.family !== 'basic' && host.family !== 'depth' && !ownBuffer(attributes.normal))
    return `material ${host.family} has no normal attribute`;
  if (host.vertexColors && !ownBuffer(attributes.color))
    return 'vertex-colour material has no color attribute';
  for (const texture of maps) {
    const reason = textureReason(texture);
    if (reason) return reason;
  }
  // A matcap's image is read at its normal's coordinate, never by a UV attribute.
  return textureReason(host.matcap);
}
