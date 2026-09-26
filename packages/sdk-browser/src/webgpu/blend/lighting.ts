import { directLightResources } from '../pages/prepare/lightResources.ts';
import type { BlendLighting } from '../core/bindEntries.ts';
import type { WebgpuPagesRuntime } from '../pages/runtime.ts';

/**
 * Lighting resources the blend pass binds: exactly those the opaque resolve just resolved,
 * and the deferred-resolve placeholders for those that do not exist yet. One resolve for both
 * passes, so the blend pass owns no light of its own (P6).
 */
export function blendLightResources(rt: WebgpuPagesRuntime): BlendLighting {
  const { placeholders } = rt.gpu.deferred!,
    contract = directLightResources(rt);
  return {
    directLights: contract.lights!,
    shadowData: contract.slices ?? placeholders.slices,
    shadowAtlas: contract.atlas ?? placeholders.atlasView,
    shadowSampler: placeholders.sampler,
    shadowTransmittance: contract.transmittance?.view ?? placeholders.transmittanceView,
    shadowTranslucentDepth: contract.transmittance?.depthView ?? placeholders.atlasView,
    bounceGrid: contract.bounceGrid ?? placeholders.bounceGrid,
    probes: contract.probes ?? placeholders.probes,
    tileLights: contract.tiles ?? placeholders.tiles,
    proxy: contract.proxy ?? placeholders.proxy,
    surfaceCache: contract.surfaceCache ?? placeholders.surfaceCache,
  };
}
