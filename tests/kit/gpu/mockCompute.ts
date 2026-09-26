import { evaluateDagSelectionKernel } from '../../../packages/sdk-browser/src/gpu/dag/selection.ts';
import type { PackedDag } from '../../../packages/sdk-browser/src/gpu/dag/selection.ts';
import { DAG_BINDING } from '../../../packages/sdk-browser/src/gpu/dag/shader/bindings.ts';
import { primitiveWordAt } from '../../../packages/sdk-browser/src/gpu/dag/worlds.ts';
import {
  DRAW_ITEM_U32,
  evaluateDrawCompact,
  indirectForDraw,
  type DrawItem,
} from '../../../packages/sdk-browser/src/gpu/draw/draw.ts';
import { compactDrawnPages } from './globals.ts';
import {
  simulateBlendExpansion,
  simulateTransparentCompaction,
  words,
} from './mockComputeBlend.ts';
import {
  SELECTION_HEADER_WORDS,
  childBase,
  residentFlags,
  selectionListCap,
  stagedRequestsWord,
  writeTriangleTotals,
} from '../../../packages/sdk-browser/src/gpu/dag/layout.ts';
import { sortRequestWords } from '../../../packages/sdk-browser/src/gpu/dag/request.ts';
import { VIEW_FLAGS_WORD } from '../../../packages/sdk-browser/src/gpu/dag/uniforms.ts';
import { VIEW_LIGHT } from '../../../packages/sdk-browser/src/gpu/dag/shader/pagesWgsl.ts';

export type ComputeBind = {
  entries: Array<{ binding: number; resource: { buffer: { data: Uint8Array } } }>;
};

/** The DAG selection uniform block as the shader reads it: the camera, and the resident-cut switch. */
export function readDagUniforms(data: Uint8Array) {
  const f32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  return {
    uniforms: {
      planes: f32.slice(0, 24),
      view: f32.slice(24, 40),
      pixelScale: [f32[40], f32[41]] as [number, number],
      pixelError: f32[42],
      near: f32[43],
      cameraWorld: [f32[48], f32[49], f32[50]] as [number, number, number],
      cameraStretch: f32[51],
    },
    residentCut: !!u32[47],
    light: (u32[VIEW_FLAGS_WORD] & VIEW_LIGHT) !== 0,
  };
}

export function simulateComputeDispatch(
  computePipeline: { entryPoint: string } | undefined,
  computeBind: ComputeBind | undefined,
  computes: string[],
  packed?: PackedDag,
  offsets?: readonly number[],
) {
  if (computePipeline?.entryPoint) computes.push(computePipeline.entryPoint);
  if (computePipeline?.entryPoint === 'scatterTransparentGroups' && computeBind)
    return simulateTransparentCompaction(computeBind);
  if (computePipeline?.entryPoint === 'writeBlendRuns' && computeBind)
    return simulateBlendExpansion(computeBind, offsets);
  if (computePipeline?.entryPoint === 'scatterGroups' && computeBind) {
    const byBinding = new Map(
      computeBind.entries.map((entry) => [entry.binding, entry.resource.buffer]),
    );
    const uniBytes = byBinding.get(1)!.data;
    const uni = new Uint32Array(uniBytes.buffer, uniBytes.byteOffset, uniBytes.byteLength / 4);
    const count = uni[0],
      maxVertexCount = uni[1],
      slotCap = uni[2];
    const itemBytes = byBinding.get(0)!.data;
    const itemInts = new Uint32Array(
      itemBytes.buffer,
      itemBytes.byteOffset,
      itemBytes.byteLength / 4,
    );
    const n = Math.min(count, slotCap);
    const restBytes = byBinding.get(7)!.data;
    const restInts = new Uint32Array(
      restBytes.buffer,
      restBytes.byteOffset,
      restBytes.byteLength / 4,
    );
    const restAt = (i: number) => ((restInts[i >> 5] >> (i & 31)) & 1) as 0 | 1;
    const items: DrawItem[] = [];
    for (let i = 0; i < n; i++)
      items.push({
        pageIndex: itemInts[i * DRAW_ITEM_U32],
        bin: itemInts[i * DRAW_ITEM_U32 + 1] as 0 | 1 | 2,
        rest: restAt(i),
      });
    const source =
      count > slotCap
        ? items.concat(
            Array.from({ length: count - n }, () => ({
              pageIndex: 0,
              bin: 0 as const,
              rest: 0 as const,
            })),
          )
        : items;
    const maskBytes = byBinding.get(6)?.data;
    const mask = maskBytes ? new Uint32Array(maskBytes.buffer) : undefined;
    const filtered =
      uni[4] && mask
        ? source.filter((_, i) => mask[uni[5] + itemInts[i * DRAW_ITEM_U32 + 2]] !== 0)
        : source;
    const result = evaluateDrawCompact(
      count > slotCap ? source : filtered,
      maxVertexCount,
      slotCap,
    );
    const offsets = byBinding.get(5)!.data;
    new Uint32Array(offsets.buffer).set(
      Array.from({ length: 6 }, (_, slot) => result.indirect[slot * 4 + 3]),
    );
    const instBytes = byBinding.get(2)!.data;
    new Uint32Array(instBytes.buffer, instBytes.byteOffset, instBytes.byteLength / 4).set(
      result.instances,
    );
    const indBytes = byBinding.get(3)!.data;
    new Uint32Array(indBytes.buffer, indBytes.byteOffset, indBytes.byteLength / 4).set(
      indirectForDraw(result),
    );
    return;
  }
  if (!packed || !computeBind) return;
  const byBinding = new Map(
    computeBind.entries.map((entry) => [entry.binding, entry.resource.buffer]),
  );
  if (computePipeline?.entryPoint === 'dagSortRequests')
    return sortStagedRequests(byBinding.get(DAG_BINDING.out)!.data, packed.pageCount);
  if (computePipeline?.entryPoint !== 'dagMask') return;
  const { uniforms, residentCut, light } = readDagUniforms(byBinding.get(DAG_BINDING.views)!.data);
  // The rule's residency lives in bits behind the cold records: the double rereads it through the
  // shared decoder, in the buffer the host writes, where the shader reads it.
  const cold = words(byBinding.get(DAG_BINDING.cold)!.data);
  const resident = residentCut
    ? {
        ready: residentFlags(cold, packed.pageCount),
        childReady: residentFlags(cold, packed.pageCount, childBase(packed.pageCount)),
      }
    : undefined;
  // World matrices are read IN THE BOUND BUFFER, where the shader reads them: image entry writes
  // them there brought back to the eye, and the view and planes of the same uniform block are of
  // that frame. A copy made at packing would put absolute worlds under a view with no translation
  // — two frames in one formula, and not a single page kept.
  const tampon = byBinding.get(DAG_BINDING.worlds)!.data;
  const worlds = new Float32Array(tampon.buffer, tampon.byteOffset, packed.worlds.length);
  // So is each primitive's root, behind its stretch in the frame buffer: a parked one is NONE
  // (`parkWorld`), and the cut skips it as the shader does.
  const frames = words(byBinding.get(DAG_BINDING.frames)!.data);
  const rootNodes = packed.rootNodes.map((_, w) => frames[primitiveWordAt(w) + 1]);
  const result = evaluateDagSelectionKernel({ ...packed, worlds, rootNodes }, uniforms, resident);
  if (residentCut) {
    const flags = new Uint32Array(byBinding.get(DAG_BINDING.flags)!.data.buffer);
    flags.fill(0, packed.nodeCount);
    for (const id of result.drawablePageIds ?? []) flags[packed.nodeCount + id] = 1;
    // The cut then compacts these flags: the sample reports only the count and its ranks.
    compactDrawnPages(
      byBinding.get(DAG_BINDING.flags)!.data,
      byBinding.get(DAG_BINDING.out)!.data,
      packed.nodeCount,
      packed.pageCount,
    );
  }
  const out = byBinding.get(DAG_BINDING.out)!.data;
  const ints = new Uint32Array(out.buffer, out.byteOffset, out.byteLength / 4);
  ints[1] = result.frustumRejected;
  ints[2] = result.lodLevel;
  writeTriangleTotals(ints, result);
  // The camera's requests wait, in the order `dagWanted` emits them, where `dagSortRequests` reads.
  const [list, at] = light
    ? [result.pageIds, SELECTION_HEADER_WORDS]
    : [result.requestWords, stagedRequestsWord(selectionListCap(packed.pageCount))];
  ints[0] = list.length;
  ints.set(list, at);
}

/** `dagSortRequests`: the staged requests into the sample, by rank, through the kernel's mirror. */
function sortStagedRequests(out: Uint8Array, pageCount: number) {
  const ints = new Uint32Array(out.buffer, out.byteOffset, out.byteLength / 4),
    listCap = selectionListCap(pageCount),
    at = stagedRequestsWord(listCap),
    count = Math.min(ints[0], listCap);
  ints.set(sortRequestWords(ints.subarray(at, at + count)), SELECTION_HEADER_WORDS);
}
