import { BLEND_ITEM_WORDS, writeBlendItemRecord } from './items.ts';
import { BLEND_VIEW_SIZE } from './uniforms.ts';
import { buildBlendStatics, refreshBlendPlan } from './plan.ts';
import { createBlendExpand } from './expand.ts';
import { EXPAND_PASSES, planWords, scratchWords } from './runs.ts';
import { writeBlendExpansionCpu } from './expandCpu.ts';
import { writeVolumeRecords } from '../transparent/transmission.ts';
import type { WebgpuPagesRuntime } from '../pages/runtime.ts';

/**
 * Everything the transparent pass holds of the SCENE, mounted once: the item records, the view
 * uniform, the indirect arguments and the GPU frustum that writes them.
 *
 * Nothing here depends on the camera. What depends on the scene — matrices, materials — is redone
 * by `refreshBlendScene`, and only when the scene has moved.
 */
export async function prepareBlendResources(rt: WebgpuPagesRuntime, device: GPUDevice) {
  const { blendState, vis } = rt,
    items = blendState.blendGpu;
  if (!items.length) return;
  // `prepare()` is public and can be called again without going through dispose: everything the
  // previous prepare mounted is released here, expansion included. Bind groups that cited those
  // buffers fall with them.
  disposeBlendResources(blendState);
  // A paged item reads the concatenated geometry, the very same as the opaque pass: its first
  // vertex there is the block of its source geometry.
  for (const item of items)
    item.vertexBase = item.paged
      ? (vis.geometryBlocks.get(item.sourceGeometry.attributes)?.vertexBase ?? 0)
      : 0;
  buildBlendStatics(blendState);
  // The scene's transparent list IS the draw list: what an image takes out of it, it takes out
  // with a zero instance count, and the readbacks keep naming the scene's items.
  blendState.visibleBlend.length = 0;
  for (const item of items) blendState.visibleBlend.push(item);
  blendState.itemPacked = new Float32Array(items.length * BLEND_ITEM_WORDS);
  blendState.itemInts = new Uint32Array(blendState.itemPacked.buffer);
  blendState.itemBuffer = device.createBuffer({
    label: 'Trillion3D blend item records',
    size: items.length * BLEND_ITEM_WORDS * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  blendState.viewBuffer = device.createBuffer({
    label: 'Trillion3D blend view uniform',
    size: BLEND_VIEW_SIZE,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // The two outputs of expansion: the instance list the shader reads at the rank the vertex index
  // gives it, and one indirect argument per slice. They belong to the scene, and the CPU fallback
  // writes them itself when the device has no compute stage.
  const entries = blendState.maxPlanEntries;
  refreshBlendScene(rt, device);
  blendState.expandedBuffer = device.createBuffer({
    label: 'Trillion3D blend expanded instances',
    size: blendState.instanceCapacity * 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  blendState.argsBuffer = device.createBuffer({
    label: 'Trillion3D blend indirect arguments',
    size: Math.max(16, entries * 16 * EXPAND_PASSES),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
  });
  blendState.expand = await createBlendExpand(
    device,
    { items: items.length, planWords: planWords(entries), scratchWords: scratchWords(entries) },
    {
      counts: blendState.compaction?.indirectBuffer,
      clusters: blendState.compaction?.instanceBuffer,
    },
    { expanded: blendState.expandedBuffer, args: blendState.argsBuffer },
  );
  blendState.expand?.uploadDraws(blendState.drawsPacked);
}

/** Releases the transparent pass's scene buffers; the groups that cited them are voided by their
 *  identity at the next pass. */
export function disposeBlendResources(blendState: WebgpuPagesRuntime['blendState']) {
  blendState.expand?.dispose();
  blendState.expand = undefined;
  for (const tampon of ['expandedBuffer', 'argsBuffer', 'itemBuffer', 'viewBuffer'] as const) {
    blendState[tampon]?.destroy();
    blendState[tampon] = undefined;
  }
}

/**
 * Records, boxes, volumes and the encode plan, rebuilt after a scene change.
 *
 * This is the ONLY remaining loop over items, and a camera that moves does not trigger it: it
 * only restarts on a matrix move or a resource mount.
 */
export function refreshBlendScene(rt: WebgpuPagesRuntime, device: GPUDevice) {
  const { blendState, vis } = rt,
    items = blendState.blendGpu,
    packed = blendState.itemPacked,
    ints = blendState.itemInts;
  if (!blendState.itemBuffer || !items.length) return;
  for (let i = 0; i < items.length; i++) writeBlendItemRecord(packed, ints, i, items[i], vis);
  device.queue.writeBuffer(
    blendState.itemBuffer,
    0,
    packed.buffer as ArrayBuffer,
    0,
    packed.byteLength,
  );
  refreshBlendPlan(blendState);
  writeVolumeRecords(rt, device);
}

/**
 * What the image asks of expansion: the frustum verdict, the order if it moved, then the two
 * kernel passes, chained in ONE compute pass.
 *
 * Dispatches of the same compute pass are ordered and see the previous writes: blend can therefore
 * hand its work memory back to transmission, whose instances and arguments live in their own
 * regions. Without a compute stage, the CPU writes exactly the same words
 * (`expandCpu.ts`).
 */
export function encodeBlendExpansion(
  rt: WebgpuPagesRuntime,
  device: GPUDevice,
  encoder: GPUCommandEncoder,
) {
  const { blendState } = rt,
    expand = blendState.expand;
  if (!expand) {
    writeBlendExpansionCpu(blendState, device);
    return;
  }
  if (blendState.keepMoved) {
    expand.uploadKeep(blendState.keepPacked);
    blendState.keepMoved = false;
  }
  const orders = blendState.orders;
  const pass = encoder.beginComputePass({ label: 'Trillion3D blend expansion' });
  for (let slice = 0; slice < orders.length; slice++) {
    const order = orders[slice],
      region = blendState.planRegions[slice];
    if (!order.length) continue;
    if (blendState.orderMoved[slice]) {
      expand.uploadPlan(region, order, blendState.runs[slice], blendState.runCount[slice]);
      blendState.orderMoved[slice] = false;
    }
    expand.encode(
      pass,
      slice,
      region,
      {
        entries: order.length,
        runs: blendState.runCount[slice],
        instanceBase: blendState.instanceBase[slice],
      },
      blendState,
    );
  }
  pass.end();
}
