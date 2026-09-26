import { DEFAULT_GEOMETRY_POOL_BUDGET } from './pools.ts';
import { DEFAULT_TEXTURE_POOL_BUDGET } from '../webgpu/residency/memoryBudgets.ts';
import { shadowAtlasBytes, shadowBufferBytes } from '../gpu/shadow/atlas.ts';
import { shadowTransmittanceBytes } from '../gpu/shadow/transmittance.ts';
import { SHADOW_BATCH_GPU_BYTES, SHADOW_BATCH_HOST_BYTES } from '../gpu/shadow/batchBudget.ts';
import {
  shadowPoolSize,
  shadowPoolShape,
} from '../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { shadowTableHostBytes } from '../../../sdk-core/src/scene/light-shadow/table.ts';
import { shadowPoolHostBytes } from '../../../sdk-core/src/scene/light-shadow/pool.ts';
import { shadowAdmissionHostBytes } from '../../../sdk-core/src/scene/light-shadow/admit.ts';
import { DEFAULT_CACHED_BYTES } from '../streaming/pageCache.ts';
import { textureLevelShare } from '../texture/levelStore.ts';
import { BOUNCE_SETTINGS } from '../../../sdk-core/src/bounce/contracts.ts';
import { bounceProbeBytes } from '../bounce/limits.ts';
import { effectChainBytesAt } from '../effects/targets.ts';

/** The pool the shadows are counted at, 3840 × 2160 under one sun (`shadowPoolSize`): the most
 *  a pool takes (`webgpu/shadow/poolSize.ts`). */
const { side, layers } = shadowPoolShape(shadowPoolSize(3840, 2160));
export const SHADOW_POOL_PAGES = side * side * layers;
/** The shadows at that pool — the atlas, its static and transmittance layers, the buffers beside
 *  it, the page table first, and what the most batches a frame draws add (`batchBudget.ts`). */
export const SHADOW_POOL_BYTES =
  2 * shadowAtlasBytes(side, layers) +
  shadowTransmittanceBytes(side, layers) +
  shadowBufferBytes(SHADOW_POOL_PAGES) +
  SHADOW_BATCH_GPU_BYTES;
/** The shadows' host memory at that pool: the table's words and change flags, the pool's page
 *  records and eviction bits, the frame's list, as the three allocate them, and the batches' flag
 *  pages and CPU cut faces. */
export const SHADOW_HOST_BYTES =
  shadowTableHostBytes(SHADOW_POOL_PAGES) +
  shadowPoolHostBytes(SHADOW_POOL_PAGES) +
  shadowAdmissionHostBytes(SHADOW_POOL_PAGES) +
  SHADOW_BATCH_HOST_BYTES;
/**
 * GPU bytes of the bounce probe cascades at their largest — every level of `cascadeSize³` probes,
 * the nine RGB coefficients, visibility and state of each, in both copies the pass binds (the
 * probes and the snapshot frozen before each update). Fixed whatever the scene.
 */
export const BOUNCE_PROBE_BYTES =
  2 * bounceProbeBytes(BOUNCE_SETTINGS.cascadeLevels * BOUNCE_SETTINGS.cascadeSize ** 3);
/** The largest canvas a budget declares: the effect chain's targets are reserved at its size. */
export interface BudgetCanvas {
  /** Width in pixels of the drawing buffer. */
  readonly width: number;
  /** Height in pixels of the drawing buffer. */
  readonly height: number;
}
/** The largest canvas a budget declares by default, in pixels of the drawing buffer: 3840 × 2160. */
export const DEFAULT_BUDGET_CANVAS: BudgetCanvas = Object.freeze({ width: 3840, height: 2160 });
/**
 * GPU bytes of the effect chain's targets on the declared canvas (`../effects/targets.ts`): two
 * pass targets, the WebGL2 scene target and every kind's own, by the one rule the renderers count
 * them with. Held only while a chain has a pass, as the targets follow the image's size.
 */
const effectTargetReserve = ({ width, height }: BudgetCanvas) => effectChainBytesAt(width, height);
/** The effect targets' reserve on the default canvas. */
export const EFFECT_TARGET_BYTES = effectTargetReserve(DEFAULT_BUDGET_CANVAS);
/**
 * Bytes by which a chain's targets on a `width × height` image pass the reserve of the declared
 * `canvas`, by the same rule; 0 within it. The chain still draws the whole image: the excess is
 * only said (`effect-targets-over-budget`).
 */
export const effectTargetExcess = (width: number, height: number, canvas: BudgetCanvas) =>
  Math.max(0, effectChainBytesAt(width, height) - effectTargetReserve(canvas));
/** The GPU bytes reserved before the pools: the shadows, the probes, the effect targets. */
const fixedGpuBytes = (canvas: BudgetCanvas) =>
  SHADOW_POOL_BYTES + BOUNCE_PROBE_BYTES + effectTargetReserve(canvas);
/** The GPU total by default for a declared canvas: the fixed shares, then the two pools at their
 *  defaults. */
export const defaultGpuBudget = (canvas: BudgetCanvas = DEFAULT_BUDGET_CANVAS) =>
  fixedGpuBytes(canvas) + DEFAULT_GEOMETRY_POOL_BUDGET + DEFAULT_TEXTURE_POOL_BUDGET;
/** The GPU total by default, on the default canvas. */
export const DEFAULT_GPU_BUDGET = defaultGpuBudget();
/** The CPU total by default: the shadow page table's host mirror, then the decoded-page cache's
 *  default, what a world's cache held before the mirror was counted. */
export const DEFAULT_CPU_BUDGET = SHADOW_HOST_BYTES + DEFAULT_CACHED_BYTES;

const checkTotal = (bytes: number, name: string) => {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error(name);
};

/**
 * One memory budget, split by a fixed rule — never by what the machine says it has:
 * - GPU: the shadow pool first (`SHADOW_POOL_BYTES`), what the atlas, its static layer and its
 *   transmittance layer take at 3840 × 2160 under one sun, with the page table and
 *   the other fixed shadow buffers; then the bounce probe cascades at their largest
 *   (`BOUNCE_PROBE_BYTES`), then the effect chain's targets on the declared `canvas`
 *   (`effectTargetReserve`, 3840 × 2160 by default); the rest in two halves, the geometry pool
 *   and the texture pool, each no larger than its ceiling. The three fixed shares never shrink: a total under them is
 *   refused by name. A total that leaves the other two less than their floors — the
 *   root cover, the texture tails — leaves them at those floors, which the pools' own clamps name.
 * - CPU: the shadow page table's host mirror first (`SHADOW_HOST_BYTES`), fixed whatever the
 *   screen; the decoded-page cache takes the rest (`pageCache.ts`), the session's manifest tables
 *   and transfer queue reserved off it. A total under the mirror is refused by name.
 *   The cut's host tables — group closure, the rule's readiness, the residency sets and the cut's
 *   differences, sized by what the view asks for and the pool holds (#483 rule 6) — are held in
 *   the cache's share too: the session reserves their bytes there (`hostTableBytes`, the
 *   streamer's `reserve`), read each time the cache weighs itself, and the decoded pages keep the
 *   rest. The decoded texture levels take at most `textureLevelShare` of it (`textureLevels`), and
 *   yield first to the pages a frame keeps.
 * At a canvas's default total (`defaultGpuBudget`), the split gives each pool its own default.
 */
export function splitMemoryBudget(
  gpu: number,
  cpu: number,
  canvas: BudgetCanvas = DEFAULT_BUDGET_CANVAS,
) {
  checkTotal(gpu, 'INVALID_GPU_BUDGET');
  checkTotal(cpu, 'INVALID_CPU_BUDGET');
  checkTotal(canvas.width, 'INVALID_BUDGET_CANVAS');
  checkTotal(canvas.height, 'INVALID_BUDGET_CANVAS');
  const fixed = fixedGpuBytes(canvas);
  if (gpu < fixed) throw new Error('GPU_BUDGET_UNDER_SHADOW_POOL');
  if (cpu <= SHADOW_HOST_BYTES) throw new Error('CPU_BUDGET_UNDER_SHADOW_MIRROR');
  const half = Math.floor((gpu - fixed) / 2);
  return {
    shadowPool: SHADOW_POOL_BYTES,
    bounceProbes: BOUNCE_PROBE_BYTES,
    effectTargets: effectTargetReserve(canvas),
    geometryPool: Math.max(1, Math.min(DEFAULT_GEOMETRY_POOL_BUDGET, half)),
    texturePool: Math.max(1, Math.min(DEFAULT_TEXTURE_POOL_BUDGET, half)),
    shadowMirror: SHADOW_HOST_BYTES,
    pageCache: cpu - SHADOW_HOST_BYTES,
    textureLevels: textureLevelShare(cpu - SHADOW_HOST_BYTES),
  };
}
