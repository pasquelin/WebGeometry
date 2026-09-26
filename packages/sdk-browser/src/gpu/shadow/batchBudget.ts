import { SHADOW_CULL_FLOATS } from '../../../../sdk-core/src/index.ts';
import { LAYER_PAGES } from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { DRAW_INDIRECT_STRIDE, PAGE_BIND_ALIGN } from '../draw/contract.ts';
import { DAG_MAX_VIEWS, DAG_UNIFORM_BYTES } from '../dag/shader/viewsWgsl.ts';
import { MAX_SHADOW_PAGES, MAX_SHADOW_REGIONS } from './recordPack.ts';

/**
 * THE MEMORY OF A FRAME'S SHADOW BATCHES, SIZED ONCE FROM A POOL LAYER. A frame draws every page
 * it marks, in as many batches as that takes (`../../webgpu/pages/render/encodeShadowBatches.ts`);
 * what each batch adds — its staged writes, its flag word, its CPU cut's faces, its sampled counts —
 * is sized here from one rule, never grown at run time, and counted in the memory budget
 * (`residency/memoryBudget.ts`).
 *
 * The rule: a frame draws at most `LAYER_PAGES` pages, and a batch holds `MAX_SHADOW_PAGES` of them,
 * so a frame needs at most `MAX_SHADOW_BATCHES` full batches, each in at most `DAG_MAX_VIEWS` light
 * views. A frame that lists more — a larger pool (#850), or a view limit a light cut bisected
 * after dropping work (`../dag/lightCutRedraws.ts`) — draws `MAX_SHADOW_BATCHES` and leaves the
 * rest pending, drawn the next frame.
 */

/** Batches one frame draws at most: `LAYER_PAGES` pages, in full batches. */
export const MAX_SHADOW_BATCHES = Math.ceil(LAYER_PAGES / MAX_SHADOW_PAGES);
/** Light views, one per face a batch draws, of one frame's batches together. */
export const MAX_SHADOW_RUNS = MAX_SHADOW_BATCHES * DAG_MAX_VIEWS;
/** Frames whose light-cut flag words may be in flight at once (`../dag/lightCutRedraws.ts`). */
export const SHADOW_FLAG_FRAMES = 4;

/** Bytes of a drawn face's uniform entry, one per region (`atlas.ts`): a dynamic-offset stride. */
export const SHADOW_FACE_STRIDE = PAGE_BIND_ALIGN;
/** Words of one face's cull uniform (`cull.ts`), of the light cut's cull uniform and its
 *  dispatch argument (`lightCull.ts`), of a region's occlusion slot and the occlusion uniform
 *  (`occlusion.ts`), and of one page's bounds in the page pyramids (`pageHiz.ts`). */
export const CULL_UNIFORM_WORDS = 8,
  LIGHT_CULL_UNIFORM_WORDS = 8,
  LIGHT_CULL_ARG_WORDS = 3,
  OCCLUSION_SLOT_WORDS = 4,
  OCCLUSION_UNIFORM_WORDS = 4,
  PAGE_BOUNDS_WORDS = 12;

/** The most one batch writes through `batchWrites.ts`, writer by writer. */
export const SHADOW_BATCH_WRITE_BYTES =
  DAG_UNIFORM_BYTES +
  MAX_SHADOW_REGIONS * SHADOW_FACE_STRIDE +
  MAX_SHADOW_REGIONS * (SHADOW_CULL_FLOATS * 4 + DRAW_INDIRECT_STRIDE) +
  DAG_MAX_VIEWS * CULL_UNIFORM_WORDS * 4 +
  (LIGHT_CULL_UNIFORM_WORDS + LIGHT_CULL_ARG_WORDS) * 4 +
  MAX_SHADOW_REGIONS * (OCCLUSION_SLOT_WORDS * 4 + DRAW_INDIRECT_STRIDE) +
  OCCLUSION_UNIFORM_WORDS * 4 +
  MAX_SHADOW_PAGES * PAGE_BOUNDS_WORDS * 4;
/** The staging buffer: every batch but the first, which writes straight (`batchWrites.ts`). */
export const SHADOW_STAGING_BYTES = (MAX_SHADOW_BATCHES - 1) * SHADOW_BATCH_WRITE_BYTES;

/** A frame's flag words on the GPU, and on the host each batch's pages, their views and where the
 *  batch ends (`../dag/lightCutRedraws.ts`). */
const FLAG_GPU_BYTES = MAX_SHADOW_BATCHES * 4,
  FLAG_HOST_BYTES =
    MAX_SHADOW_BATCHES *
      MAX_SHADOW_PAGES *
      (Int32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT) +
    MAX_SHADOW_BATCHES * Uint16Array.BYTES_PER_ELEMENT;
/** The CPU cut's per-face offsets, lengths and commands on the host, its commands on the GPU
 *  (`../../webgpu/shadow/cpuCasters.ts`). */
const CPU_RUN_HOST_BYTES = 4 + 4 + DRAW_INDIRECT_STRIDE,
  CPU_RUN_GPU_BYTES = DRAW_INDIRECT_STRIDE;

/** A sampled frame's region commands, every batch's (`cullCounts.ts`), and the samplers that copy
 *  them: the cull's and the occlusion test's. */
export const SHADOW_COUNT_SAMPLE_BYTES =
    MAX_SHADOW_BATCHES * MAX_SHADOW_REGIONS * DRAW_INDIRECT_STRIDE,
  SHADOW_COUNT_SAMPLERS = 2;

/** GPU bytes the batches add, at their largest: staging, flag words, CPU cut commands, and the
 *  cull and occlusion count samples. */
export const SHADOW_BATCH_GPU_BYTES =
  SHADOW_STAGING_BYTES +
  SHADOW_FLAG_FRAMES * FLAG_GPU_BYTES +
  MAX_SHADOW_RUNS * CPU_RUN_GPU_BYTES +
  SHADOW_COUNT_SAMPLERS * SHADOW_COUNT_SAMPLE_BYTES;
/** Host bytes the batches add, at their largest: the flag frames' pages, the CPU cut's faces. */
export const SHADOW_BATCH_HOST_BYTES =
  SHADOW_FLAG_FRAMES * FLAG_HOST_BYTES + MAX_SHADOW_RUNS * CPU_RUN_HOST_BYTES;
