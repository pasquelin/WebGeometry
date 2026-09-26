import type { GpuPassTimings } from '../../../sdk-core/src/index.ts';
import { BOUNCE_PROBE_PASS } from '../bounce/probeWgsl.ts';
import { BOUNCE_SURFACE_PASS } from '../bounce/surfaceWgsl.ts';
import { DEFERRED_LIGHTING_PASS } from '../lighting/deferred/deferred.ts';
import { TAA_PASS } from '../taa/shaderWgsl.ts';
import { LIGHT_TILES_PASS } from '../lighting/tiles/tiles.ts';
import { REST_COMPACT_PASS } from '../gpu/raster/restCompact.ts';
import { SHADOW_PASS } from '../gpu/shadow/atlas.ts';
import { SHADOW_LAYER_PASS } from '../gpu/shadow/staticLayer.ts';
import { SHADOW_TRANSMITTANCE_PASS } from '../gpu/shadow/transmittance.ts';
import { LIGHT_CUT_PASS } from '../gpu/dag/encode.ts';
import { MATERIAL_DEPTH_PASS, MATERIAL_SURFACES_PASS } from '../webgpu/core/materialPasses.ts';
import { PARTICLES_PASS } from '../particles/webgpuParticles.ts';
import { PARTICLE_DRAW_PASS } from '../particles/webgpuParticleDraw.ts';
import type { StageAdd } from './profiler.ts';

/**
 * The two blocks of a frame that can be set against a published profile, and nothing else.
 * `visibility` is building the visibility buffer: selection, partition, Hi-Z and raster.
 * `materials` is writing surfaces from that buffer. Everything else is `other`: shadows, light
 * lists, bounce, transparents, deferred lighting, present, and the fallback path that does not go
 * through the buffer — putting any of those in a block would inflate a comparison instead of
 * serving it, so they stay outside AND named, each pass keeping its duration.
 */
export type GpuPassBlock = 'visibility' | 'materials' | 'other';

/** A shadow page's GPU cost: choosing its casters, then drawing them. Sampling is in `lighting`. */
type ShadowPart = 'cull' | 'raster';

/** A pass's row: its stage and block, plus its shadow part when it serves shadow pages. */
type PassRow = readonly [stage: string, block: GpuPassBlock, part?: ShadowPart];

/**
 * Profile stage, comparison block and shadow part of each GPU pass, read from the label the pass
 * already carries. This is the only read of deposit labels: direct-light durations, the per-stage
 * profile and the blocks share it. An unknown label joins `geometry`, the only stage that draws
 * without a name of its own, and `other`, so a new pass does not silently swell a compared block.
 */
const PASSES: Readonly<Record<string, PassRow>> = Object.freeze({
  'Trillion3D DAG selection': ['selection', 'visibility'],
  'Trillion3D partition': ['partition', 'visibility'],
  'Trillion3D draw compaction': ['selection', 'visibility'],
  [REST_COMPACT_PASS]: ['geometry', 'other'],
  'Trillion3D HiZ pyramid': ['hiZ', 'visibility'],
  'Trillion3D HiZ test': ['hiZ', 'visibility'],
  'Trillion3D clear': ['geometry', 'visibility'],
  'Trillion3D visibility primary': ['geometry', 'visibility'],
  'Trillion3D visibility secondary': ['geometry', 'visibility'],
  'Trillion3D small triangle binning': ['geometry', 'visibility'],
  'Trillion3D small triangle raster': ['geometry', 'visibility'],
  'Trillion3D hybrid visibility resolve': ['geometry', 'visibility'],
  // Compute raster (`../gpu/raster/raster.ts`, `../gpu/raster/resolve.ts`): it builds the same buffer.
  'Trillion3D raster target and lists': ['geometry', 'visibility'],
  'Trillion3D raster dispatch': ['geometry', 'visibility'],
  'Trillion3D raster binning': ['geometry', 'visibility'],
  'Trillion3D raster occluder depth': ['geometry', 'visibility'],
  'Trillion3D raster tested depth': ['geometry', 'visibility'],
  'Trillion3D raster identifiers': ['geometry', 'visibility'],
  'Trillion3D raster occluder hiz': ['hiZ', 'visibility'],
  'Trillion3D raster resolve': ['geometry', 'visibility'],
  'Trillion3D empty surfaces': ['geometry', 'materials'],
  [MATERIAL_DEPTH_PASS]: ['geometry', 'materials'],
  [MATERIAL_SURFACES_PASS]: ['geometry', 'materials'],
  'Trillion3D opaque fallback': ['geometry', 'other'],
  'Trillion3D transparents': ['transparents', 'other'],
  'Trillion3D transmission': ['transparents', 'other'],
  'Trillion3D water surfaces': ['transparents', 'other'],
  'Trillion3D water composite': ['transparents', 'other'],
  'Trillion3D transparent compaction': ['transparents', 'other'],
  [PARTICLE_DRAW_PASS]: ['transparents', 'other'],
  [SHADOW_PASS]: ['shadows', 'other', 'raster'],
  [SHADOW_LAYER_PASS]: ['shadows', 'other', 'raster'],
  [SHADOW_TRANSMITTANCE_PASS]: ['shadows', 'other', 'raster'],
  [LIGHT_CUT_PASS]: ['shadowCasters', 'other', 'cull'],
  'Trillion3D shadow cull': ['shadows', 'other', 'cull'],
  'Trillion3D shadow page pyramids': ['shadows', 'other', 'cull'],
  'Trillion3D shadow occlusion': ['shadows', 'other', 'cull'],
  [LIGHT_TILES_PASS]: ['lightLists', 'other'],
  [BOUNCE_SURFACE_PASS]: ['bounce', 'other'],
  [BOUNCE_PROBE_PASS]: ['bounce', 'other'],
  [PARTICLES_PASS]: ['physics', 'other'],
  [DEFERRED_LIGHTING_PASS]: ['lighting', 'other'],
  [TAA_PASS]: ['antialiasing', 'other'],
  'Trillion3D HDR composition': ['present', 'other'],
  'Trillion3D HDR composition + present': ['present', 'other'],
  'Trillion3D direct present': ['present', 'other'],
  'Trillion3D explicit capture': ['present', 'other'],
});

/** Stage of a pass, by its label. Unknown is `geometry`. */
export const gpuPassStageOf = (name: string) => PASSES[name]?.[0] ?? 'geometry';
/** Block of a pass, by its label. Unknown is `other`. */
export const gpuPassBlockOf = (name: string): GpuPassBlock => PASSES[name]?.[1] ?? 'other';
/** Shadow part of a pass, by its label. A pass that serves no shadow page is `other`. */
export const gpuShadowPartOf = (name: string) => PASSES[name]?.[2] ?? 'other';

/** Stages the WebGPU engine can name, in the order they occur. */
export const WEBGPU_STAGES = [
  'physics',
  'animations',
  'lights',
  'cutAdoption',
  'selection',
  'transparents',
  'residency',
  'hostPages',
  'uploads',
  'textures',
  'partition',
  'encode',
  'submit',
  'hiZ',
  'geometry',
  'coplanar',
  'shadows',
  'shadowCasters',
  'sunFarShadows',
  'lightLists',
  'bounce',
  'lighting',
  'antialiasing',
  'present',
] as const;

/** Stages the WebGL2 engine can name. */
export const WEBGL_STAGES = [
  'physics',
  'animations',
  'lights',
  'hierarchyCut',
  'selection',
  'uploads',
  'residency',
  'submit',
  'frame',
] as const;

/**
 * GPU duration of a sample by pass group, in one walk, `classify` naming each pass's
 * group. `null` for a group whose one pass has no usable duration: a partial sum would
 * pass for a measurement. A truncated or missing sample yields no group, for the same reason.
 */
export function gpuTotalsBy<Group extends string>(
  sample: GpuPassTimings | null | undefined,
  classify: (name: string) => Group,
) {
  const totals = new Map<Group, number | null>();
  if (!sample || sample.truncated) return totals;
  for (const pass of sample.passes) {
    const group = classify(pass.name);
    const total = totals.get(group);
    if (total === null) continue;
    totals.set(group, pass.gpuMs === null ? null : (total ?? 0) + pass.gpuMs);
  }
  return totals;
}

/** GPU duration of each profile stage. */
const gpuStageTotals = (sample: GpuPassTimings | null | undefined) =>
  gpuTotalsBy(sample, gpuPassStageOf);

/** Split a sample onto profile stages: what is not measured is not deposited. */
export function addGpuPasses(sample: GpuPassTimings | null | undefined, add: StageAdd) {
  for (const [stage, ms] of gpuStageTotals(sample)) if (ms !== null) add(stage, ms);
}

/**
 * GPU duration of a sample's "Bounce" stage, or `null`: that is the measurement the
 * millisecond budget servos. A missing stage, a truncated sample or a device without
 * timestamps yield `null`, and the servo does not move rather than follow a zero.
 */
export function bounceGpuMs(sample: GpuPassTimings | null | undefined) {
  return gpuStageTotals(sample).get('bounce') ?? null;
}

/** The direct-lighting durations of the frame, read from the same sample by label. */
export function directLightTimings(sample: GpuPassTimings | null | undefined) {
  const totals = gpuStageTotals(sample),
    parts = gpuTotalsBy(sample, gpuShadowPartOf);
  return {
    gpuLightListsMs: totals.get('lightLists') ?? null,
    gpuShadowsMs: totals.get('shadows') ?? null,
    gpuShadowCullMs: parts.get('cull') ?? null,
    gpuShadowRasterMs: parts.get('raster') ?? null,
    gpuLightingMs: totals.get('lighting') ?? null,
  };
}
