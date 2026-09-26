import type { PhysicsBudget } from '../../../../sdk-core/src/physics/index.ts';
import type { FrameMetrics } from '../../../../sdk-core/src/index.ts';
import type { MeasuredWorld } from '../session/explorer.ts';
import type { WorldRenderer } from '../capability/worldReady.ts';
import { DEFAULT_GEOMETRY_POOL_BUDGET } from '../../residency/pools.ts';
import { DEFAULT_TEXTURE_POOL_BUDGET } from '../../webgpu/residency/memoryBudgets.ts';
import {
  DEFAULT_BUDGET_CANVAS,
  DEFAULT_CPU_BUDGET,
  defaultGpuBudget,
  splitMemoryBudget,
  type BudgetCanvas,
} from '../../residency/memoryBudget.ts';
import { raycastTreeBudget } from '../../../../sdk-core/src/world/object/raycastTrees.ts';
import {
  createPageCache,
  DEFAULT_CACHED_BYTES,
  type PageCache,
} from '../../streaming/pageCache.ts';

/** The pools a page asks for, the two totals and the declared canvas, kept to open every later session with them; and
 *  the world's decoded-page cache, which every session reads through — one reopened, on a device
 *  granted after a loss or on a changed scene, fetches nothing it holds. */
export type Pools = {
  geometryPool?: number;
  texturePool?: number;
  gpu?: number;
  cpu?: number;
  canvas?: BudgetCanvas;
  readonly pageCache: PageCache;
};

/** A world's pools, none asked yet, and its page cache at its share of the default CPU total. */
export const worldPools = (): Pools => ({ pageCache: createPageCache(DEFAULT_CACHED_BYTES) });

/** The GPU total as asked, else the default total of the declared canvas. */
const gpuOf = (pools: Pools) => pools.gpu ?? defaultGpuBudget(pools.canvas);
/** The split of the totals as asked, the defaults for those not set. */
const splitOf = (pools: Pools, gpu = gpuOf(pools), canvas = pools.canvas) =>
  splitMemoryBudget(gpu, pools.cpu ?? DEFAULT_CPU_BUDGET, canvas);

/** What a session opens with: the pools as asked, and the world's page cache. */
export const sessionPools = (pools: Pools) => ({
  geometryPoolBytes: pools.geometryPool,
  texturePoolBytes: pools.texturePool,
  pageCache: pools.pageCache,
});

/**
 * `world.budget`: one GPU total and one CPU total, split across the pools by a fixed rule
 * (`splitMemoryBudget`), and the pools themselves, as properties. A pool write is clamped to its
 * ceiling and to what the GPU total leaves it, then applied with the session's `setMemoryBudgets`;
 * two writes before the next frame make one rebalance. A read is what the last frame held, or what
 * was asked before the first.
 */
export function worldBudget(
  pools: Pools,
  session: { readonly explorer: MeasuredWorld | null },
  frames: { readonly last: FrameMetrics | null },
  renderer: () => WorldRenderer | null,
  physics: PhysicsBudget,
) {
  let pending = false;
  const rebalance = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      void session.explorer?.setMemoryBudgets({
        geometryPoolBytes: pools.geometryPool,
        texturePoolBytes: pools.texturePool,
      });
    });
  };
  // What the last frame published, `null` or `undefined` when it held no such pool.
  const held = (key: string) => (frames.last as Record<string, number | null> | null)?.[key];
  const split = () => splitOf(pools);
  /** What the GPU total leaves a pool beside the fixed shares and the other pool as asked. */
  const room = (other: 'geometryPool' | 'texturePool', ceiling: number) => {
    const { shadowPool, bounceProbes, effectTargets, ...shares } = split();
    const left = gpuOf(pools) - shadowPool - bounceProbes - effectTargets;
    return Math.max(1, Math.min(ceiling, left - (pools[other] ?? shares[other])));
  };
  /** Redraws both pools by the split of `gpu` on `canvas`; a refused total changes nothing. */
  const redraw = (gpu: number, canvas = pools.canvas) => {
    const shares = splitOf(pools, gpu, canvas);
    pools.geometryPool = shares.geometryPool;
    pools.texturePool = shares.texturePool;
    rebalance();
  };
  return {
    /** The physics envelopes (bodies, decorative bodies, memory), read once when the physics
     *  starts; exceeding one raises `PHYSICS_BUDGET`. */
    physics,
    /** Bytes of GPU memory the world may hold, all pools together; set it to redraw every pool
     *  by the split rule (`split`). A total under the three fixed shares — the shadow pool, the
     *  bounce probes and the effect targets — is refused (`GPU_BUDGET_UNDER_SHADOW_POOL`). Never
     *  read from the machine. */
    get gpu() {
      return gpuOf(pools);
    },
    set gpu(bytes: number) {
      redraw(bytes);
      pools.gpu = bytes;
    },
    /** The largest canvas the world declares, in pixels of the drawing buffer: the effect chain's
     *  targets are reserved at its size (`split.effectTargets`); 3840 × 2160 by default, and the
     *  default `gpu` grows by that reserve only. Set it to redraw every pool by the split. A canvas
     *  drawn larger still renders whole: the diagnostics say `effect targets over budget` with the
     *  bytes past the reserve. */
    get canvas(): BudgetCanvas {
      return pools.canvas ?? DEFAULT_BUDGET_CANVAS;
    },
    set canvas({ width, height }: BudgetCanvas) {
      const canvas = Object.freeze({ width, height });
      redraw(pools.gpu ?? defaultGpuBudget(canvas), canvas);
      pools.canvas = canvas;
    },
    /** Bytes of CPU memory the world may hold: the shadow page table's host mirror, then the
     *  decoded pages, their manifest tables, their transfer queue and the engine's cut tables
     *  together. A change applies at once: pages leave by last use until they fit. A total not
     *  above the mirror is refused (`CPU_BUDGET_UNDER_SHADOW_MIRROR`). Never read from the
     *  machine. */
    get cpu() {
      return pools.cpu ?? DEFAULT_CPU_BUDGET;
    },
    set cpu(bytes: number) {
      const { pageCache } = splitMemoryBudget(gpuOf(pools), bytes, pools.canvas);
      pools.cpu = bytes;
      pools.pageCache.resize(pageCache);
    },
    /** How the two totals are shared: the shadow pool and the bounce probes at their largest, the
     *  effect chain's targets on the declared `canvas`, then half each to the geometry and texture
     *  pools, capped at their ceilings; the shadow table's host mirror, then the decoded-page cache takes the whole rest of the CPU total,
     *  within which the session in place reserves its manifest tables, its transfer queue and the
     *  engine's cut tables. What the rule gives, before a pool set on its own. */
    get split() {
      return split();
    },
    /** The largest pools a world may ask for: the engine's starting budgets. */
    get geometryPoolCeiling() {
      return DEFAULT_GEOMETRY_POOL_BUDGET;
    },
    /** The largest texture pool a world may ask for, in bytes. */
    get texturePoolCeiling() {
      return DEFAULT_TEXTURE_POOL_BUDGET;
    },
    /** Bytes of GPU memory kept for geometry pages; set it to change the envelope, within what
     *  `gpu` leaves beside the shadows, the bounce probes and the texture pool. */
    get geometryPool() {
      return held('geometryPoolBytes') ?? pools.geometryPool ?? split().geometryPool;
    },
    set geometryPool(bytes: number) {
      pools.geometryPool = Math.min(bytes, room('texturePool', DEFAULT_GEOMETRY_POOL_BUDGET));
      rebalance();
    },
    /** Bytes of GPU memory kept for texture pages, `null` on an engine without a texture pool
     *  (WebGL2); set it to change the envelope, within what `gpu` leaves beside the shadows, the
     *  bounce probes and the geometry pool. */
    get texturePool(): number | null {
      if (renderer() === 'webgl2') return null;
      return held('texturePoolBytes') ?? pools.texturePool ?? split().texturePool;
    },
    set texturePool(bytes: number) {
      pools.texturePool = Math.min(bytes, room('geometryPool', DEFAULT_TEXTURE_POOL_BUDGET));
      rebalance();
    },
    /** Bytes of CPU memory `raycast` keeps for triangle trees, shared by every world on the page;
     *  past it the tree cast at least recently is dropped. Set it to change the envelope. */
    get raycastTrees() {
      return raycastTreeBudget.bytes;
    },
    set raycastTrees(bytes: number) {
      raycastTreeBudget.bytes = bytes;
    },
  };
}
