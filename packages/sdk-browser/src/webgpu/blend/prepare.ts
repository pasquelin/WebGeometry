import { BOX_VALUES } from '../../../../sdk-core/src/index.ts';
import type { BlendCopy } from '../../cluster/blendCopyContract.ts';
import type { BlendHostScene } from '../../cluster/blendSceneRecord.ts';
import { refreshBlendBounds } from './worlds.ts';
import {
  FLAG_BACK,
  FLAG_DOUBLE,
  FLAG_HAS_COLOR,
  FLAG_HAS_NORMAL,
  FLAG_HAS_TANGENT,
  FLAG_LIT,
  FLAG_PAGED,
  FLAG_TRANSMISSIVE,
} from '../../visibility/buffer.ts';
import { WATER_RANK_SHIFT } from '../water/surfaceWgsl.ts';
import { neverCulled } from '../../visibility/shader/spriteWgsl.ts';
import { ensureWebgpuPositionBuffer } from '../core/positions.ts';
import { ensureBlendIndexBuffer, ensureBlendNormalBuffer, ensureBlendUvBuffer } from './buffers.ts';
import type { createWebgpuBlendState } from './state.ts';
import type { WebgpuGpuState } from '../pages/state/gpu.ts';
type BlendState = ReturnType<typeof createWebgpuBlendState>;

/** Creates forward transparent GPU items, one per copy — per placement —, in source mesh order. */
export function prepareWebgpuBlend(
  device: GPUDevice,
  blendCopies: readonly BlendCopy[],
  gpu: WebgpuGpuState,
  blendState: BlendState,
  scene: BlendHostScene,
) {
  let transmissive = 0;
  for (const copy of blendCopies) {
    // A transmissive surface goes through the same prepare as the other blends: it differs only
    // at draw, where the water pass composes it over the frozen backdrop instead of blending it.
    const mat = copy.surface;
    const transmits = mat.transmission > 0;
    const attr = copy.geometry.attributes.position,
      idx = copy.geometry.getIndex();
    if (!attr || !idx) continue;
    const position = ensureWebgpuPositionBuffer(
      device,
      copy.geometry.attributes,
      gpu.positionBuffers,
      gpu,
    )!;
    const paged = !!copy.userData.pagedBlend;
    // A paged primitive reads its indices from the page cache, cluster by cluster: it owns none.
    // The other three buffers belong to the geometry, not the placement: nine instances of one
    // object write them once. The bytes are the same, the item order too.
    const index = paged ? undefined : ensureBlendIndexBuffer(device, idx, gpu);
    const uv = paged ? undefined : ensureBlendUvBuffer(device, copy.geometry.attributes, gpu);
    const tangentAttr = copy.geometry.attributes.tangent;
    const normal = paged
      ? undefined
      : ensureBlendNormalBuffer(device, copy.geometry.attributes, gpu);
    const hasNormal = paged ? !!copy.geometry.attributes.normal : !!normal;
    let flags = 0;
    if (mat.lit) flags |= FLAG_LIT;
    if (mat.doubleSided) flags |= FLAG_DOUBLE;
    if (hasNormal) flags |= FLAG_HAS_NORMAL;
    if (tangentAttr) flags |= FLAG_HAS_TANGENT;
    if (mat.vertexColors && copy.geometry.attributes.color) flags |= FLAG_HAS_COLOR;
    if (mat.backSide) flags |= FLAG_BACK;
    if (paged) flags |= FLAG_PAGED;
    // Its water rank, one-based and compact over the transmissive items, rides above the flags:
    // the surface stage writes it and the composite reads the item's volume at that rank.
    if (transmits) flags |= FLAG_TRANSMISSIVE | (++transmissive << WATER_RANK_SHIFT);
    // No transform is baked here: the item carries the live world matrix of its source mesh, and
    // its box is SET by the same path that will refresh it after a move. The world box stays
    // conservative under rotation, mirror, non-uniform scale and shear — `boxTransform` guarantees
    // that, not a decomposition. A surface never culled (`neverCulled`) takes none either.
    let worldBox: Float64Array | undefined;
    if (copy.frustumCulled && !neverCulled(mat)) {
      if (!copy.geometry.boundingBox) copy.geometry.computeBoundingBox();
      if (copy.geometry.boundingBox) worldBox = new Float64Array(BOX_VALUES);
    }
    const item = {
      transmissive: transmits,
      position,
      index,
      uv,
      normal,
      surface: mat,
      count: paged ? 0 : idx.count,
      matrix: copy.matrix,
      placement: copy.placement,
      sourceMesh: copy.userData.sourceMesh,
      sourceGeometry: copy.geometry,
      worldBox,
      bounds: undefined as Float64Array | undefined,
      flags,
      paged,
      // Reset by `refreshEyeKeys` before each sort; here only so they exist.
      orderKey: 0,
      orderRank: 0,
    };
    refreshBlendBounds(item);
    blendState.blendGpu.push(item);
    if (paged) blendState.pagedBlendGpu.set(item.matrix, item);
    scene.remove(copy);
  }
  return transmissive;
}
