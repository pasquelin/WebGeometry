/**
 * Every WGSL text the engine hands to `createShaderModule`, by the name of its module, each
 * variant a pass can compile under its own name: the diagnostic and water additions, the DAG's
 * external-reference screen error, each composition input. A pass that sizes its text
 * (`rasterSource`, `drawShader`, `transparentOcclusionShader`) is taken at one size: the size
 * changes a constant, never a name.
 */
import { PRESENT_SHADER } from './presentation.ts';
import { transparentOcclusionShader } from './transparentOcclusionWgsl.ts';
import { DAG_SELECTION_SHADER } from '../dag/shader/shader.ts';
import { withScreenErrorVariant } from '../dag/shader/error.ts';
import { drawShader } from '../draw/shader.ts';
import { ROW_MAP_SHADER } from '../draw/lightRows.ts';
import { HIZ_SHADER } from '../hiz/shader.ts';
import { PARTITION_SHADER } from '../partition/shader.ts';
import { RESOLVE, rasterSource } from '../raster/shader.ts';
import { REST_COMPACT_SHADER } from '../raster/restCompactWgsl.ts';
import { SHADOW_CULL_SHADER, SHADOW_LIGHT_CULL_SHADER } from '../shadow/cullShader.ts';
import { SHADOW_OCCLUSION_SHADER } from '../shadow/occlusionShader.ts';
import { SHADOW_DEPTH_SHADER } from '../shadow/shader.ts';
import { RESTORE_WGSL } from '../shadow/staticLayer.ts';
import { BOUNCE_PROBE_SHADER } from '../../bounce/probeWgsl.ts';
import { BOUNCE_SURFACE_SHADER } from '../../bounce/surfaceWgsl.ts';
import { DIAGNOSTIC_SHADE_WGSL, DIAGNOSTIC_VIS_WGSL } from '../../diagnostic/gpuGeometry.ts';
import { DIAGNOSTIC_BLEND_WGSL } from '../../diagnostic/gpuVariant.ts';
import { BLOOM_WGSL } from '../../effects/bloomWgsl.ts';
import { GUIDE_WGSL } from '../../guides/guideShaders.ts';
import {
  BOUNCE_LIGHTING_SHADER,
  COMPOSE_SHADERS,
  DIRECT_LIGHTING_SHADER,
  UNLIT_COMPOSE_SHADERS,
  UNLIT_LIGHTING_SHADER,
} from '../../lighting/deferred/shaders.ts';
import { LIGHT_TILES_SHADER } from '../../lighting/tiles/shader.ts';
import { TAA_SHADER } from '../../taa/shaderWgsl.ts';
import { MIP_SHADER } from '../../texture/mips.ts';
import { COVERAGE_WGSL } from '../../texture/coverageMips.ts';
import { SHADE_SHADER, VIS_SHADER } from '../../visibility/buffer.ts';
import { BLEND_EXPAND_SHADER } from '../../webgpu/blend/expandWgsl.ts';
import { BLEND_SHADER } from '../../webgpu/blend/shader.ts';
import { SHADER as PREPARE_SHADER } from '../../webgpu/pages/prepare/shaders.ts';
import { REDUCE_WGSL } from '../../webgpu/tile/reduce.ts';
import { TRANSPARENT_COMPACT_SHADER } from '../../webgpu/transparent/shader.ts';
import { WATER_COMPOSITE_SHADER } from '../../webgpu/water/compositeWgsl.ts';
import { WATER_SURFACE_WGSL } from '../../webgpu/water/surfaceWgsl.ts';
import { PARTICLES_WGSL } from '../../particles/webgpuParticles.ts';
import { PARTICLE_DRAW_WGSL } from '../../particles/webgpuParticleDraw.ts';

const compositions = (label: string, sources: Record<string, string>) =>
  Object.fromEntries(Object.entries(sources).map(([input, code]) => [`${label}_${input}`, code]));

export const ENGINE_SHADERS: Record<string, string> = {
  PRESENT_SHADER,
  TRANSPARENT_OCCLUSION: transparentOcclusionShader(64),
  DAG_SELECTION_SHADER,
  DAG_SELECTION_REFERENCE: withScreenErrorVariant(DAG_SELECTION_SHADER, 'reference'),
  DRAW_SHADER: drawShader(2),
  ROW_MAP_SHADER,
  HIZ_SHADER,
  PARTITION_SHADER,
  RASTER: rasterSource(4096, 16),
  RESOLVE,
  REST_COMPACT_SHADER,
  SHADOW_CULL_SHADER,
  SHADOW_LIGHT_CULL_SHADER,
  SHADOW_OCCLUSION_SHADER,
  SHADOW_DEPTH_SHADER,
  RESTORE_WGSL,
  BOUNCE_PROBE_SHADER,
  BOUNCE_SURFACE_SHADER,
  BLOOM_WGSL,
  GUIDE_WGSL,
  UNLIT_LIGHTING_SHADER,
  DIRECT_LIGHTING_SHADER,
  BOUNCE_LIGHTING_SHADER,
  ...compositions('COMPOSE', COMPOSE_SHADERS),
  ...compositions('UNLIT_COMPOSE', UNLIT_COMPOSE_SHADERS),
  LIGHT_TILES_SHADER,
  TAA_SHADER,
  MIP_SHADER,
  COVERAGE_WGSL,
  VIS_SHADER,
  VIS_DIAGNOSTIC: VIS_SHADER + DIAGNOSTIC_VIS_WGSL,
  SHADE_SHADER,
  SHADE_DIAGNOSTIC: SHADE_SHADER + DIAGNOSTIC_SHADE_WGSL,
  BLEND_SHADER,
  BLEND_WATER: BLEND_SHADER + WATER_SURFACE_WGSL,
  BLEND_DIAGNOSTIC: BLEND_SHADER + DIAGNOSTIC_BLEND_WGSL,
  BLEND_EXPAND_SHADER,
  PREPARE_SHADER,
  REDUCE_WGSL,
  TRANSPARENT_COMPACT_SHADER,
  WATER_COMPOSITE_SHADER,
  PARTICLES_WGSL,
  PARTICLE_DRAW_WGSL,
};
