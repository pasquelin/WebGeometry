import { SHADOW_ARRAY } from '../../gpu/shadow/layers.ts';
import { BLEND_SHADER } from './shader.ts';
import { FEEDBACK_FORMAT } from '../../scene/surfaceBuffer.ts';
import { BLEND_VIEW_SIZE } from './uniforms.ts';
import type { BlendGpuItem } from './state.ts';
import { BLEND_BINDINGS, atlasLayoutEntries, readOnly } from '../core/bindLayout.ts';
import { WATER_SURFACE_WGSL } from '../water/surfaceWgsl.ts';
import {
  blendStagePipelines,
  blendStagePipelinesNow,
  pipelinesByMode,
  type BlendModePipelines,
} from './stagePipelines.ts';
import type { Blending } from '../../../../sdk-core/src/world/constants/index.ts';
import { BLEND_EQUATIONS, BLEND_MODES } from '../../scene/materialBlending.ts';
import { refreshSurface } from '../../page/surface.ts';
import { createWaterPass, type WaterPass } from '../water/pass.ts';
import {
  blendVariantPipeline,
  DIAGNOSTIC_BLEND_WGSL,
  type DiagnosticGpuVariant,
} from '../../diagnostic/gpuVariant.ts';

/** Builds the forward-material pipelines for transparent draws, and the water pass of a scene
 *  that transmits. */
export async function createWebgpuBlendPipelines(
  device: GPUDevice,
  items: BlendGpuItem[],
  variant?: DiagnosticGpuVariant,
) {
  const b = BLEND_BINDINGS;
  // Without a variant, the module and the targets are exactly those of before: production compiles
  // no diagnostic stage and has no write mask of its own.
  const { entryPoint, writeMask } = blendVariantPipeline(variant);
  const blendBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: b.indices, visibility: GPUShaderStage.VERTEX, buffer: readOnly },
      { binding: b.positions, visibility: GPUShaderStage.VERTEX, buffer: readOnly },
      { binding: b.uvs, visibility: GPUShaderStage.VERTEX, buffer: readOnly },
      {
        binding: b.uniform,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', minBindingSize: BLEND_VIEW_SIZE },
      },
      // Each item's record, read at the rank the vertex index carries: it is what replaces the
      // dynamic uniform offset, and therefore the bind group per draw.
      { binding: b.items, visibility: GPUShaderStage.VERTEX, buffer: readOnly },
      ...atlasLayoutEntries(b.color),
      { binding: b.sampler, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ...atlasLayoutEntries(b.data),
      { binding: b.normals, visibility: GPUShaderStage.VERTEX, buffer: readOnly },
      { binding: b.directLights, visibility: GPUShaderStage.FRAGMENT, buffer: readOnly },
      { binding: b.clusterDiagnostic, visibility: GPUShaderStage.VERTEX, buffer: readOnly },
      { binding: b.planInstances, visibility: GPUShaderStage.VERTEX, buffer: readOnly },
      { binding: b.clusterSpans, visibility: GPUShaderStage.VERTEX, buffer: readOnly },
      { binding: b.shadowData, visibility: GPUShaderStage.FRAGMENT, buffer: readOnly },
      {
        binding: b.shadowAtlas,
        visibility: GPUShaderStage.FRAGMENT,
        texture: SHADOW_ARRAY,
      },
      {
        binding: b.shadowSampler,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'comparison' },
      },
      {
        binding: b.shadowTransmittance,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
      },
      {
        binding: b.shadowTranslucentDepth,
        visibility: GPUShaderStage.FRAGMENT,
        texture: SHADOW_ARRAY,
      },
      { binding: b.bounceGrid, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: b.probes, visibility: GPUShaderStage.FRAGMENT, buffer: readOnly },
      { binding: b.tileLights, visibility: GPUShaderStage.FRAGMENT, buffer: readOnly },
      // Resident proxy of the far sun shadow: **read-only**, and that is the condition of early
      // depth rejection for the whole pass. A binding writable from the fragment stage forces the
      // GPU to shade every fragment before testing it, side effect and all — here 4232 fragment
      // draws fully hidden behind opaque. The shadow ray is the same; only the two census counters
      // stay with deferred resolve, which can write. It is the eighth and last storage binding of
      // this fragment stage, the one the spec still guarantees.
      { binding: b.proxy, visibility: GPUShaderStage.FRAGMENT, buffer: readOnly },
    ],
  });
  // The water pass exists for a scene that transmits, outside any diagnostic variant: under one,
  // the transmission slice draws as one more blend, so the variant measures the same fragment
  // stage on all of it. Its surface stage is compiled into the blend module only then.
  const wantsWater = !variant && items.some((item) => item.transmissive);
  const blendModule = device.createShaderModule({
    code:
      BLEND_SHADER +
      (wantsWater ? WATER_SURFACE_WGSL : '') +
      (variant ? DIAGNOSTIC_BLEND_WGSL : ''),
  });
  // Normal always — the transmission slice draws on it under a diagnostic —, then every mode a
  // blend item declares: a scene of plain glass compiles the three pipelines it always did. A mode
  // written on a surface later is compiled by the first draw that asks for it (`at`).
  const modes = BLEND_MODES.filter(
    (mode, rank) =>
      !rank ||
      items.some((item) => !item.transmissive && refreshSurface(item.surface).blending === mode),
  );
  const fragment = (mode: Blending): GPUFragmentState => ({
    module: blendModule,
    entryPoint,
    targets: [
      { format: 'rgba16float', writeMask, blend: BLEND_EQUATIONS[mode] },
      // Tile rank the pixel requests from the virtual textures: an integer target, without blend,
      // that reduction rereads after the pass.
      { format: FEEDBACK_FORMAT },
    ],
  });
  const perMode = pipelinesByMode((mode) =>
    blendStagePipelinesNow(device, blendModule, blendBindGroupLayout, fragment(mode), false),
  );
  const compiled = await Promise.all(
    modes.map((mode) =>
      blendStagePipelines(device, blendModule, blendBindGroupLayout, fragment(mode), false),
    ),
  );
  modes.forEach((mode, at) => (perMode.byMode[BLEND_MODES.indexOf(mode)] = compiled[at]));
  const blendPipelines: BlendModePipelines = {
    byMode: perMode.byMode,
    at(rank) {
      const mode = BLEND_MODES[Math.floor(rank / 3)];
      if (!mode) throw new Error(`blend pipeline rank ${rank} names no blending mode`);
      return perMode.at(mode)[rank % 3];
    },
  };
  // A device that refuses the pass keeps the blends, and `waterRefused` names why to the caller.
  let water: WaterPass | undefined, waterRefused: Error | undefined;
  if (wantsWater)
    try {
      water = await createWaterPass(device, blendModule, blendBindGroupLayout);
    } catch (error) {
      waterRefused = error instanceof Error ? error : new Error(String(error));
    }
  return {
    blendBindGroupLayout,
    blendPipelines,
    water,
    waterRefused,
  };
}
