import { frustumExcludesBox } from '../../../../sdk-core/src/index.ts';
import { blendFootprintHeld, holdBlendRanking } from './footprint.ts';
import { planItem } from './plan.ts';
import { buildBlendRuns } from './runs.ts';
import { notDrawn } from '../../placement/hidden.ts';
import type { BlendGpuItem, createWebgpuBlendState } from './state.ts';
type BlendState = ReturnType<typeof createWebgpuBlendState>;

/**
 * PAINT ORDER OF TRANSPARENT SURFACES, REDONE EVERY FRAME.
 *
 * A blend pipeline does not write depth (`pipelines.ts`): two transparent surfaces are
 * therefore separated by nothing other than the order they are encoded in. The encoding plan is a
 * SCENE object — source order, rebuilt only when matrices move — and cannot carry this decision,
 * which depends on the eye. This file carries it: it does not touch the plan, it orders the entry
 * list the pass walks.
 *
 * WHAT WE RANK ON: the square of the eye-to-WORLD-box-centre distance of the item, decreasing —
 * farthest first, nearest last. A frank distance, never a normalised depth: the engine convention
 * is inverted (`../../camera/depthConvention.ts`) and ranking on it would read backwards. The square is enough,
 * it is monotonic in the distance.
 *
 * THE GAP IS TAKEN RELATIVE TO THE EYE, bound by bound, before being averaged: that is the space
 * of the rest of the path, and an absolute world centre would lose its useful bits far from the
 * origin.
 */

/** Key of an item: without a usable box, the world origin of its mesh stands in. */
function eyeKey(item: BlendGpuItem, ex: number, ey: number, ez: number) {
  const box = item.bounds,
    m = item.matrix.elements;
  const x = box ? (box[0] - ex + (box[3] - ex)) / 2 : m[12] - ex,
    y = box ? (box[1] - ey + (box[4] - ey)) / 2 : m[13] - ey,
    z = box ? (box[2] - ez + (box[5] - ez)) / 2 : m[14] - ez;
  return x * x + y * y + z * z;
}

/** Sets each item's key and source rank. Nothing is allocated: two fields rewritten. */
function refreshEyeKeys(blendState: BlendState, eye: ArrayLike<number>) {
  const items = blendState.blendGpu,
    ex = eye[0],
    ey = eye[1],
    ez = eye[2];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    item.orderRank = i;
    item.orderKey = eyeKey(item, ex, ey, ez);
  }
}

/**
 * FRUSTUM VERDICT OF THE FRAME: a box against six planes, in double precision and by the
 * reference itself. It goes to the GPU as one bit per item, and plan expansion zeros the
 * instances of what it rejects (`expandWgsl.ts`) — an out-of-view item no longer costs
 * a draw, it no longer costs an instance. Without a usable box, the item is never rejected.
 *
 * A SECOND walk of the same items, not one more line in the key walk: the work is the same, but
 * the fused loop slowed the sort that follows by four to nine percent on a camera jump, measured
 * by `transparents-ordres.bench.ts` and reproduced over five runs. The mechanism is not proven;
 * the remedy is measured.
 */
function rejectByFrustum(blendState: BlendState) {
  const items = blendState.blendGpu,
    keep = blendState.keepPacked,
    planes = blendState.blendPlanes;
  let rejected = 0,
    transmissiveInView = 0,
    bouge = false,
    mot = 0;
  // The mask is composed word by word, and a word is written only if it has changed: a still pose
  // changes none, and that is what spares the frame from pushing it to the GPU again.
  const pose = (rang: number) => {
    if (keep[rang] !== mot >>> 0) {
      keep[rang] = mot;
      bouge = true;
    }
    mot = 0;
  };
  for (let i = 0; i < items.length; i++) {
    const box = items[i].bounds;
    // A hidden node's or a parked row's item is kept out like a rejected one, without counting as rejected.
    const parked = notDrawn(items[i]);
    if (
      !parked &&
      box &&
      frustumExcludesBox(planes, box[0], box[1], box[2], box[3], box[4], box[5])
    )
      rejected++;
    else if (!parked) {
      mot |= 1 << (i & 31);
      // The water pass is encoded for a surface in view, never for a scene that merely has one.
      if (items[i].transmissive) transmissiveInView++;
    }
    if ((i & 31) === 31) pose(i >>> 5);
  }
  if (items.length & 31) pose(items.length >>> 5);
  blendState.keepMoved = bouge;
  blendState.transmissiveInView = transmissiveInView;
  return rejected;
}

/**
 * Total order both paths produce: decreasing key, then increasing source rank.
 *
 * Rank breaks equal keys, so the result depends neither on the previous frame, nor on arrival
 * order, nor on the machine — two overlapping items cannot swap from one frame to the next, so
 * the image does not flicker. `true` says the already-placed entry must recede.
 */
const precedes = (keyA: number, rankA: number, keyB: number, rankB: number) =>
  keyA < keyB || (keyA === keyB && rankA > rankB);

/**
 * Insertion sort of the plan, on the buffer the previous frame left.
 *
 * A camera that moves little leaves the list almost sorted: insertion takes it back in one walk
 * and a few shifts, where a full sort remakes it entirely. The buffer is the scene's, rewritten
 * in place, and both entries of a double-sided item drawn in two passes carry the same rank —
 * they therefore never overtake each other, and the back stays in front of the face.
 */
function sortPlanFarToNear(order: Uint32Array, items: readonly BlendGpuItem[]) {
  let shifted = false;
  for (let i = 1; i < order.length; i++) {
    const entry = order[i],
      moved = items[planItem(entry)],
      movedKey = moved.orderKey,
      movedRank = moved.orderRank;
    let j = i - 1;
    while (j >= 0) {
      const held = items[planItem(order[j])];
      if (!precedes(held.orderKey, held.orderRank, movedKey, movedRank)) break;
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = entry;
    // One question per entry, not one write per shift: a camera jump shifts millions of times, and
    // the sort must pay nothing more than before to say so.
    if (j + 1 !== i) shifted = true;
  }
  return shifted;
}

/**
 * Ranking of the production path, and the run slicing it commands.
 *
 * Runs depend only on order: a ranking that moved nothing leaves them as they are, and the GPU
 * then has nothing to reread. Returns the number of items the frustum rejected.
 *
 * WITHOUT AN EYE, NOTHING IS PAINTED, and the runs are explicitly emptied. This function no
 * longer holds only the order: it holds the frustum verdict and the slicing, and leftover runs
 * would describe an order the frame did not rank — worse, a plan reseeded to another length
 * since would index them out of itself. A frame without a camera has no paint order; it therefore
 * does not paint.
 */
export function orderBlendPasses(blendState: BlendState, eye: ArrayLike<number> | undefined) {
  if (!eye || !blendState.blendGpu.length) {
    blendState.runCount[0] = 0;
    blendState.runCount[1] = 0;
    blendState.transmissiveInView = 0;
    blendState.footprint.held = false;
    return 0;
  }
  // Inputs bit-identical to the last ranking: it stands, mask and runs included (`footprint.ts`).
  if (blendFootprintHeld(blendState, eye)) return blendState.footprint.rejected;
  refreshEyeKeys(blendState, eye);
  const rejected = rejectByFrustum(blendState);
  const { blendGpu: items, orders, orderMoved } = blendState;
  for (let pass = 0; pass < orders.length; pass++) {
    // Runs a frame without an eye emptied are sliced again, even when the order held still.
    const voided = !blendState.runCount[pass] && orders[pass].length;
    if (!sortPlanFarToNear(orders[pass], items) && !voided && !orderMoved[pass]) continue;
    orderMoved[pass] = true;
    blendState.runCount[pass] = buildBlendRuns(orders[pass], blendState.runs[pass]);
  }
  holdBlendRanking(blendState.footprint, rejected);
  return rejected;
}

/**
 * The same ranking for the fallback path, whose draw list is made of items and not of plan
 * entries. The comparison is the one above: both paths paint in the same order, and a machine
 * without a visibility buffer does not see another image.
 */
export function orderVisibleBlend(blendState: BlendState, eye: ArrayLike<number> | undefined) {
  if (!eye || !blendState.blendGpu.length) return;
  refreshEyeKeys(blendState, eye);
  const visible = blendState.visibleBlend;
  for (let i = 1; i < visible.length; i++) {
    const moved = visible[i],
      movedKey = moved.orderKey,
      movedRank = moved.orderRank;
    let j = i - 1;
    for (; j >= 0; j--) {
      const held = visible[j];
      if (!precedes(held.orderKey, held.orderRank, movedKey, movedRank)) break;
      visible[j + 1] = held;
    }
    visible[j + 1] = moved;
  }
}
