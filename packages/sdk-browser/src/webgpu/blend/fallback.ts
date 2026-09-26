import { viewProj } from '../pages/helpers.ts';
import { UNIFORM_STRIDE } from './uniforms.ts';
import { voidStaleBlendGroups } from './identity.ts';
import { refreshSurface } from '../../page/surface.ts';
import { writeSpriteWords } from '../../visibility/shader/spriteWgsl.ts';
import { drawnBlending } from '../../scene/materialBlending.ts';
import type { WebgpuPagesRuntime } from '../pages/runtime.ts';
import type { createWebgpuBlendState } from './state.ts';

type BlendState = ReturnType<typeof createWebgpuBlendState>;

/** Words of one fallback draw: the visible item, its first index word, its index count. */
export const DRAW_WORDS = 3;

/**
 * The fallback pass's draws of the image into `blendState.fallbackDraws`, `DRAW_WORDS` each. An
 * unpaged item draws its own indices once. The fallback shader reads no instance, so a paged item
 * draws each cluster the CPU cut kept, in table order, from the span its page holds in the cache —
 * drawn whole through the compaction's arguments, it drew nothing (#584). A cluster not resident
 * has an empty span and draws nothing, as in the blend pass. A GPU cut leaves no CPU instance
 * list to read: that frame is refused by name, never drawn without its paged transparents.
 */
export function listFallbackBlendDraws(blendState: BlendState, gpuCut: boolean) {
  const {
    visibleBlend: items,
    table,
    cpuInstances,
    cpuItemCounts,
    fallbackDraws: list,
  } = blendState;
  list.length = 0;
  for (let i = 0; i < items.length; i++) {
    const { paged, pagedIndex, count } = items[i];
    if (!paged || !table || pagedIndex === undefined) {
      list.push(i, 0, count);
      continue;
    }
    if (gpuCut) throw new Error('FALLBACK_BLEND_WITHOUT_CPU_CUT');
    // The base the CPU cut wrote this item's instances at (`writeCpuTransparentInstances`), read
    // from the table: `item.tableBase` is only set by the transparent plan, which a prepare that
    // failed before the blend resources never builds.
    const tableBase = table.itemRanges[pagedIndex * 2];
    for (let k = tableBase; k < tableBase + cpuItemCounts[pagedIndex]; k++) {
      const span = cpuInstances[k] * 2;
      if (table.spans[span + 1]) list.push(i, table.spans[span], table.spans[span + 1]);
    }
  }
  return list;
}

/**
 * The transparent fallback path: the one for devices where the visibility buffer could not be
 * set up. It keeps the generic shader, its per-draw uniform and its CPU selection — it is not
 * the path of production frames, and nothing in it has been optimised. Writes one uniform per
 * draw `listFallbackBlendDraws` listed, from `uniformBase` on.
 */
export function writeFallbackBlendUniforms(
  rt: WebgpuPagesRuntime,
  device: GPUDevice,
  uniformBase: number,
  list: readonly number[],
) {
  const { run, blendState } = rt,
    items = blendState.visibleBlend,
    draws = list.length / DRAW_WORDS,
    { uniformPacked } = rt.gpu,
    uniformBuffer = rt.gpu.uniformBuffer!;
  const words = UNIFORM_STRIDE / 4;
  const packedInts = new Uint32Array(
    uniformPacked.buffer,
    uniformPacked.byteOffset,
    uniformPacked.length,
  );
  let last = -1,
    surface = undefined as ReturnType<typeof refreshSurface> | undefined;
  for (let d = 0; d < draws; d++) {
    const at = d * DRAW_WORDS,
      item = items[list[at]],
      base = (uniformBase + d) * words;
    // The draws of one item follow each other: its surface is read, and checked, once.
    if (list[at] !== last) {
      last = list[at];
      surface = refreshSurface(item.surface);
      // This path reads float positions and no direction: a line quad could not be widened
      // (`lineClip`), and is refused by name rather than dropped.
      if ((surface.lineWidth ?? 0) > 0) throw new Error('FALLBACK_TRANSPARENT_LINES_UNSUPPORTED');
    }
    uniformPacked.set(viewProj, base);
    uniformPacked.set(item.matrix.elements, base + 16);
    uniformPacked[base + 32] = surface!.baseColor[0];
    uniformPacked[base + 33] = surface!.baseColor[1];
    uniformPacked[base + 34] = surface!.baseColor[2];
    uniformPacked[base + 35] = surface!.opacity;
    packedInts[base + 36] = list[at + 1];
    packedInts[base + 37] = list[at + 2];
    packedInts[base + 38] = run.diagnostic === 'wireframe' ? 1 : 0;
    packedInts[base + 39] = item.flags;
    // No width and no dash: the words a line page of the opaque draw may have left here.
    uniformPacked[base + 40] = 0;
    uniformPacked[base + 44] = 0;
    // A sprite turns to face the camera like in every raster (`spriteAt`).
    writeSpriteWords(uniformPacked, base + 46, surface!.sprite);
  }
  device.queue.writeBuffer(
    uniformBuffer,
    uniformBase * UNIFORM_STRIDE,
    uniformPacked.subarray(uniformBase * words, (uniformBase + draws) * words),
  );
}

/** Encodes the fallback pass: one bind group per item and one dynamic offset per draw, and the
 *  pipeline of its blending mode, set when it changes. */
export function drawFallbackBlendPass(
  rt: WebgpuPagesRuntime,
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  uniformBase: number,
  list: readonly number[],
) {
  const { gpu, run, blendState } = rt,
    items = blendState.visibleBlend,
    draws = list.length / DRAW_WORDS;
  let unpaged = 0;
  voidStaleBlendGroups(rt);
  const pass = encoder.beginRenderPass({
    label: 'Trillion3D transparents',
    colorAttachments: [{ view: gpu.colorView!, loadOp: 'load', storeOp: 'store' }],
    depthStencilAttachment: { view: gpu.depthView!, depthLoadOp: 'load', depthStoreOp: 'store' },
  });
  pass.setViewport(0, 0, gpu.targetSize[0], gpu.targetSize[1], 0, 1);
  let bound: GPURenderPipeline | undefined,
    last = -1;
  for (let d = 0; d < draws; d++) {
    const at = d * DRAW_WORDS,
      item = items[list[at]],
      indices = list[at + 2];
    if (list[at] !== last) {
      last = list[at];
      // Each item in its own mode, the one table's equation: a mode no path draws is refused by
      // name. Its draws follow each other, so the pipeline and the group are resolved once.
      const mode = drawnBlending(refreshSurface(item.surface).blending, !!item.transmissive);
      const pipeline = gpu.pipelineBlend!.at(mode);
      if (pipeline !== bound) pass.setPipeline((bound = pipeline));
      item.group ??= device.createBindGroup({
        layout: gpu.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: item.index ?? gpu.cache!.buffer } },
          { binding: 1, resource: { buffer: item.position } },
          { binding: 2, resource: { buffer: gpu.uniformBuffer!, size: UNIFORM_STRIDE } },
        ],
      });
    }
    pass.setBindGroup(0, item.group!, [(uniformBase + d) * UNIFORM_STRIDE]);
    pass.draw(indices);
    // A paged item's triangles are the cut's, counted with it.
    if (!item.paged) unpaged += indices / 3;
  }
  pass.end();
  run.gpuDrawCalls += draws;
  run.blendDrawCalls += draws;
  run.blendUnpagedTriangles += unpaged;
  run.blendSubmittedTriangles = run.blendPagedTriangles + run.blendUnpagedTriangles;
}
