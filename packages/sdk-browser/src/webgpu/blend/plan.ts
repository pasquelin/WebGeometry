import { matrixWindingCw } from '../../../../sdk-core/src/index.ts';
import { refreshSurface, surfaceSide, type PageSurface } from '../../page/surface.ts';
import { BLEND_MODES, drawnBlending } from '../../scene/materialBlending.ts';
import { blendChunkWords, blendVertexShift, planRegions, RUN_WORDS } from './runs.ts';
import type { BlendGpuItem, createWebgpuBlendState } from './state.ts';
type BlendState = ReturnType<typeof createWebgpuBlendState>;

/** The three cull ranks of a pass's pipelines: a plan entry picks them without a test, and the
 *  rank, plus three per blend mode (`BLEND_MODES`), indexes the pipelines of the pass
 *  (`BlendModePipelines`, `draw.ts`). The water surfaces have only the three normal ones. */
const PIPELINE_NONE = 0,
  PIPELINE_FRONT = 1,
  PIPELINE_BACK = 2;
/**
 * A plan entry: the item rank, the vertex-cull bit, the SHARE bit, then the pipeline in the low
 * four — five blend modes of three culls, the cull mode being the pipeline modulo three.
 *
 * The share bit is in the entry, not read on the item, because run slicing walks the SORTED plan:
 * following an item rank to its object is a random memory access per entry, when the only plan
 * read is a sequential walk.
 *
 * VERTEX CULL: the back and the face of a double-sided paged item used to set two pipelines, so
 * each broke the run of the other and a double-sided scene drew one call per entry. Its entries
 * now keep their cull mode but set the pipeline that culls nothing, and the vertex stage drops the
 * triangles that mode would have culled (`shader.ts`): the back and the face then share one run,
 * still in the same order, back first. An unpaged item keeps the hardware cull: its own buffers
 * give it its own draw anyway. `runs.ts` and `expandWgsl.ts` read the low six bits from here:
 * shifting the rank without following them would let the other sites compile and decode wrong.
 */
export const PLAN_SHIFT = 6,
  PLAN_PIPELINE_MASK = 15,
  PLAN_SHARED_BIT = 16,
  PLAN_VERTEX_CULL_BIT = 32;
export const planEntry = (item: number, pipeline: number, shared: boolean, vertexCull = false) =>
  (item << PLAN_SHIFT) |
  (vertexCull ? PLAN_VERTEX_CULL_BIT : 0) |
  (shared ? PLAN_SHARED_BIT : 0) |
  pipeline;
export const planItem = (entry: number) => entry >>> PLAN_SHIFT;
/** Cull mode of the entry, whoever applies it: its rank among the three pipelines of its mode. */
export const planCull = (entry: number) => (entry & PLAN_PIPELINE_MASK) % 3;
/** Cull mode the vertex stage applies to the entry's instances: zero when the pipeline culls. */
export const planVertexCull = (entry: number) =>
  entry & PLAN_VERTEX_CULL_BIT ? planCull(entry) : PIPELINE_NONE;
/** Pipeline the entry sets: its mode's one that culls nothing when the vertex stage culls for it. */
export const planPipeline = (entry: number) => (entry & PLAN_PIPELINE_MASK) - planVertexCull(entry);
export const planShared = (entry: number) => (entry & PLAN_SHARED_BIT) !== 0;
/** No paged primitive behind this item: it draws its own indices, in chunks. */
export const DRAW_UNPAGED = 0xffffffff;
/** Plan entries an item can set at most: the back and the face of a double-sided material. */
const MAX_SIDES = 2;

/**
 * Addressing stride of the scene: large enough for the longest instance, small enough for the
 * rank of a run's first instance to fit in the high bits of a vertex index. A paged cluster sets
 * the floor; an unpaged primitive, split into chunks, can yield if the expanded list gets too long.
 */
function sceneVertexShift(items: readonly BlendGpuItem[], paged: number, capacity: number) {
  // Only UNPAGED primitives depend on the stride: their lengths are gathered once, and capacity
  // is recomputed on that list alone when the stride yields.
  const libres: number[] = [];
  let longest = paged;
  for (const item of items)
    if (!item.paged) {
      libres.push(item.count);
      longest = Math.max(longest, item.count);
    }
  const floor = blendVertexShift(paged);
  let shift = blendVertexShift(longest);
  while (shift > floor && instanceCapacity(libres, shift, capacity) * 2 ** shift > 0xffffffff)
    shift--;
  return shift;
}

/** Instances the scene can expand at most: the paged table, plus the others' chunks, and all of
 *  that twice — a double-sided material drawn in two passes carries two plan entries. */
function instanceCapacity(libres: readonly number[], shift: number, capacity: number) {
  let total = capacity;
  for (const count of libres) total += Math.ceil(count / blendChunkWords(shift, count));
  return total * MAX_SIDES;
}

/**
 * Static tables of the transparent pass: what an instance draws, and where its item is named.
 *
 * A paged instance draws a cluster, an unpaged instance a chunk of at most one index stride. The
 * vertex index no longer carries the item rank but the rank of its run's first instance
 * (`runs.ts`): that is what lets a whole run fit in ONE draw, and all paged items share
 * ONE bind group.
 */
export function buildBlendStatics(blendState: BlendState) {
  const items = blendState.blendGpu,
    table = blendState.table;
  const paged = table?.maxVertexWords ?? 0;
  const shift = sceneVertexShift(items, paged, table?.length ?? 0);
  blendState.vertexShift = shift;
  blendState.maxVertexWords = Math.max(3, paged);
  const draws = new Uint32Array(Math.max(1, items.length) * 4);
  // The two passes expand their instances into TWO disjoint regions of the same list. Their size
  // is that of the WORST CASE — two plan entries per item — not that of the current plan:
  // `sidesOf` reads the item's surface RECORD, refilled in place by its declaration, and a material switched
  // to double-sided between two frames would overflow the list and push the transmission region
  // past its end. Out-of-bounds kernel writes are dropped silently: transparent geometry would
  // vanish without an error.
  const room = [0, 0];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    item.tableBase =
      item.paged && table && item.pagedIndex !== undefined
        ? table.itemRanges[item.pagedIndex * 2]
        : 0;
    const known = item.paged && table && item.pagedIndex !== undefined;
    draws[i * 4] = known ? item.pagedIndex! : DRAW_UNPAGED;
    draws[i * 4 + 2] = item.tableBase;
    if (known) {
      // Instances a plan entry can expand at most: what the table holds for this item. The kernel
      // reads this word only for an unpaged primitive.
      draws[i * 4 + 1] = table!.itemRanges[item.pagedIndex! * 2 + 1];
      room[item.transmissive ? 1 : 0] += MAX_SIDES * draws[i * 4 + 1];
      continue;
    }
    const words = blendChunkWords(shift, item.count);
    draws[i * 4 + 1] = Math.ceil(item.count / words);
    draws[i * 4 + 3] = words;
    room[item.transmissive ? 1 : 0] += MAX_SIDES * draws[i * 4 + 1];
  }
  blendState.instanceBase[1] = room[0];
  blendState.instanceCapacity = Math.max(1, room[0] + room[1]);
  blendState.drawsPacked = draws;
  blendState.keepPacked = new Uint32Array(Math.max(1, (items.length + 31) >> 5));
  // Same worst case for the plan tables and its runs, and for the same reason.
  const entries = Math.max(1, items.length) * MAX_SIDES;
  blendState.maxPlanEntries = entries;
  blendState.planRegions = planRegions(entries);
  blendState.runs = [new Uint32Array(entries * RUN_WORDS), new Uint32Array(entries * RUN_WORDS)];
}

/** First pipeline rank of an item's blend mode (`drawnBlending`, which refuses by name). */
const modeBase = (surface: PageSurface, transmissive: boolean) =>
  BLEND_MODES.indexOf(drawnBlending(surface.blending, transmissive)) * 3;

/** Plan entries of an item: back then face for a double-sided one drawn in two passes, else one. */
function sidesOf(item: BlendGpuItem) {
  // One determinant: the call used to yield the same value twice to pick the two faces.
  const renverse = matrixWindingCw(item.matrix.elements);
  const front = renverse ? PIPELINE_FRONT : PIPELINE_BACK,
    back = renverse ? PIPELINE_BACK : PIPELINE_FRONT;
  // The record is reread here: the host writes `side` on the declaration it shares with its
  // mesh, and the plan is what must see it (see the room reserved above).
  const surface = refreshSurface(item.surface);
  const side = surfaceSide(surface),
    base = modeBase(surface, !!item.transmissive);
  if (side === 'double' && !surface.forceSinglePass) return [base + back, base + front];
  if (side === 'front') return [base + front];
  if (side === 'back') return [base + back];
  return [base + PIPELINE_NONE];
}

/**
 * Encoding plan, rebuilt when the scene has changed matrices — and never per frame. An entry
 * carries the item rank and the pipeline to set, so neither ranking nor run slicing reads a
 * material.
 */
export function refreshBlendPlan(blendState: BlendState) {
  const items = blendState.blendGpu;
  const blend: number[] = [],
    transmission: number[] = [];
  // Triangles each pass SUBMITS: a double-sided item drawn in two passes submits its own twice,
  // since it carries two plan entries. Counted here, with the plan, and never per frame.
  let blendTriangles = 0,
    transmissionTriangles = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i],
      into = item.transmissive ? transmission : blend;
    const sides = sidesOf(item),
      vertexCull = !!item.paged && sides.length === MAX_SIDES;
    for (const side of sides) {
      into.push(planEntry(i, side, !!item.paged, vertexCull));
      if (item.paged) continue;
      if (item.transmissive) transmissionTriangles += item.count / 3;
      else blendTriangles += item.count / 3;
    }
  }
  // Paint order starts again from source order: that is the only time it is seeded, and per-frame
  // ranking then takes it back in place, never reallocating. There is nothing to keep of the
  // unranked plan: nobody rereads it, and a second copy of the same list would have to be kept in
  // agreement with the one that is painted.
  blendState.orders = [Uint32Array.from(blend), Uint32Array.from(transmission)];
  blendState.orderMoved[0] = true;
  blendState.orderMoved[1] = true;
  blendState.blendTriangles = blendTriangles;
  blendState.transmissionTriangles = transmissionTriangles;
}
