import type { DagViewUniforms, PackedDag } from './types.ts';
import { firstAheadRequest, requestPage } from './request.ts';
import {
  OUT_COUNT,
  OUT_FLAGS,
  OUT_FRUSTUM_REJECTED,
  OUT_LOD_LEVEL,
  OUT_SELECTED_TRIANGLES,
  OUT_TRANSPARENT_TRIANGLES,
  SELECTION_HEADER_WORDS,
  selectionListCap,
} from './layout.ts';
import type { SelectionResult } from '../core/selection.ts';
import { VIEW_APPEND, VIEW_LIGHT, VIEW_PAGES } from './shader/pagesWgsl.ts';
import { DAG_VIEW_WORDS } from './shader/viewsWgsl.ts';
import { AHEAD_VIEW } from './shader/aheadWgsl.ts';

/** Word of view 0's block that says what kind of view the cut serves (`shader/pagesWgsl.ts`). */
export const VIEW_FLAGS_WORD = 54;

/** A light cut's views: how many it runs, how many it holds, its queues' bound, and whether it
 *  appends to the requests an earlier batch of the frame listed (`VIEW_APPEND`). */
export type DagCutViews = { count: number; capacity: number; queueCap: number; append?: boolean };

/**
 * Arrays of a readback slot, reused from one read to the next: reallocating them on every
 * readback threw tens of thousands of elements at the garbage collector, to rewrite exactly
 * the same ranks.
 */
export type DagOutputScratch = {
  result: SelectionResult;
  drawable: number[];
  ahead: number[];
};
export const createDagOutputScratch = (): DagOutputScratch => ({
  result: {
    pageIds: [],
    frustumRejected: 0,
    lodLevel: 0,
    selectedTriangles: 0,
    drawnTriangles: 0,
    transparentTriangles: 0,
  },
  drawable: [],
  ahead: [],
});

/** The view ahead of a moving camera (`shader/aheadWgsl.ts`): block 1 repeats the camera's with the
 *  planes and view ahead, block 0 says it is there; a light view's short block never carries one. */
function writeAheadBlock(target: Float32Array, ints: Uint32Array, uniforms: DagViewUniforms) {
  const ahead = uniforms.ahead,
    at = AHEAD_VIEW * DAG_VIEW_WORDS;
  if (!ahead || uniforms.light || target.length < at + DAG_VIEW_WORDS) return;
  target.copyWithin(at, 0, DAG_VIEW_WORDS);
  target.set(ahead.planes, at);
  target.set(ahead.view, at + 24);
  ints[63] = 1;
}

/**
 * One view's block of the uniform array (`shader/viewsWgsl.ts`). `views` says how many views the
 * cut runs and how many its buffers were sized for, and the capacity of each descent queue: a
 * camera runs one view on buffers sized for one, whose queues hold every node.
 */
export function writeDagUniforms(
  target: Float32Array,
  packed: PackedDag,
  uniforms: DagViewUniforms,
  residentCut: boolean,
  views?: DagCutViews,
) {
  target.fill(0);
  target.set(uniforms.planes, 0);
  target.set(uniforms.view, 24);
  target[40] = uniforms.pixelScale[0];
  target[41] = uniforms.pixelScale[1];
  target[42] = uniforms.pixelError;
  target[43] = uniforms.near;
  const ints = new Uint32Array(target.buffer, target.byteOffset, target.length);
  ints[44] = packed.pageCount;
  ints[45] = packed.nodeCount;
  ints[46] = packed.worldCount;
  ints[47] = residentCut ? 1 : 0;
  const cw = uniforms.cameraWorld;
  if (cw) {
    target[48] = cw[0];
    target[49] = cw[1];
    target[50] = cw[2];
  }
  target[51] = uniforms.cameraStretch ?? 1;
  // Sample cap the kernel reads to bound its two halves and to say, when it happens, that it
  // truncated (`layout.ts`).
  ints[52] = selectionListCap(packed.pageCount);
  // The projection's clip-w weight: 1 perspective, 0 orthographic (`screenErrorBound.ts`).
  target[53] = uniforms.perspective ?? 1;
  // A light cut's view: its kind, then the face pages it draws into (`shader/pagesWgsl.ts`).
  ints[60] = views?.count ?? 1;
  ints[61] = views?.capacity ?? 1;
  ints[62] = views?.queueCap ?? packed.nodeCount;
  const light = uniforms.light;
  ints[VIEW_FLAGS_WORD] = light ? VIEW_LIGHT | VIEW_PAGES | (views?.append ? VIEW_APPEND : 0) : 0;
  writeAheadBlock(target, ints, uniforms);
  if (!light) return;
  ints[55] = light.rows;
  ints[56] = light.mask[0];
  ints[57] = light.mask[1];
  target[58] = light.clipScale;
  target[59] = light.clipPad;
}

/** `drawnWordOffset`: rank of the compacted-list count in the sample, 0 when there is none. */
export function parseDagOutput(
  bytes: ArrayBufferLike,
  byteOffset: number,
  byteLength: number,
  drawnWordOffset: number,
  scratch: DagOutputScratch = createDagOutputScratch(),
): SelectionResult | null {
  const ints = new Uint32Array(bytes, byteOffset, Math.floor(byteLength / 4));
  const head = SELECTION_HEADER_WORDS;
  const count = Math.min(
    ints[OUT_COUNT] ?? 0,
    Math.max(0, (drawnWordOffset || ints.length) - head),
  );
  // Arrays sized in advance: reading a frame does not grow an empty array element by element,
  // and a typed-array iterator is never unrolled.
  const { result, drawable } = scratch,
    pageIds = result.pageIds;
  // Each rank is a REQUEST: the page and its priority in one word (`request.ts`). The GPU wrote
  // them SORTED, highest `requestRank` first (`shader/snapshotWgsl.ts`): every visible request, then
  // the view ahead's. The host reads them in that order and ranks nothing: it only finds where the
  // view ahead's start.
  const ahead = scratch.ahead;
  const visible = firstAheadRequest(ints, head, head + count) - head;
  pageIds.length = visible;
  ahead.length = count - visible;
  for (let i = 0; i < visible; i++) pageIds[i] = requestPage(ints[head + i]);
  for (let i = visible; i < count; i++) ahead[i - visible] = requestPage(ints[head + i]);
  result.aheadPageIds = ahead;
  result.frustumRejected = ints[OUT_FRUSTUM_REJECTED] ?? 0;
  result.lodLevel = ints[OUT_LOD_LEVEL] ?? 0;
  // Totals the GPU holds: they describe the cut, not the list that reports it, so a truncated
  // sample still returns them correctly (`shader/totalsWgsl.ts`).
  result.selectedTriangles = ints[OUT_SELECTED_TRIANGLES] ?? 0;
  result.transparentTriangles = ints[OUT_TRANSPARENT_TRIANGLES] ?? 0;
  // The rule draws what it selects: one counter, published under both names.
  result.drawnTriangles = result.selectedTriangles;
  // Bit 1: the cut did not fit under the sample cap. This is not a GPU fault — the kernels ran,
  // the frame mask is correct — but the reported LIST is truncated, and nothing that lives off
  // it must take it for the whole cut.
  result.truncated = ((ints[OUT_FLAGS] ?? 0) & 1) !== 0;
  result.drawablePageIds = undefined;
  // The drawable list arrives already compacted, in increasing order: the CPU no longer walks
  // one flag per DAG page, only the ranks the GPU kept.
  if (drawnWordOffset) {
    const drawnCount = Math.min(
      ints[drawnWordOffset] ?? 0,
      Math.max(0, ints.length - drawnWordOffset - head),
    );
    drawable.length = drawnCount;
    for (let i = 0; i < drawnCount; i++) drawable[i] = ints[drawnWordOffset + head + i];
    result.drawablePageIds = drawable;
  }
  return result;
}
