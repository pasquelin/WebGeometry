import {
  LIGHT_SETTINGS,
  MAX_SHADOW_SLICES,
  SHADOW_RECORD_FLOATS,
} from '../../../../sdk-core/src/index.ts';
import {
  SHADOW_RECORD_FRAME,
  SHADOW_RECORD_INFO,
  SHADOW_RECORD_ORIGINS,
} from '../../../../sdk-core/src/scene/light-shadow/faces.ts';
import { SHADOW_PAGE } from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import type { SunLevels } from '../../../../sdk-core/src/scene/light-shadow/sunLevels.ts';

/** Pages one GPU batch draws: the size of the per-batch buffers. A frame draws every page it
 *  marks, in as many batches as that takes (`../../webgpu/pages/render/encodeShadowBatches.ts`). */
export const MAX_SHADOW_PAGES: number = LIGHT_SETTINGS.shadowPagesPerBatch;
/** Regions at most in a batch: a page draws its static layer and its moving casters, two at most. */
export const MAX_SHADOW_REGIONS = 2 * MAX_SHADOW_PAGES;

/**
 * Host mirrors of the two shadow buffers the frame writes — the drawn pages' matrices, read by
 * dynamic offset, and the records the shading rereads — and the only writes into them. A record
 * is pushed only when one of its numbers changed: a still light, and a still camera for a sun,
 * push nothing.
 */
export function createShadowRecordPack(faceStride: number, poolSide: number) {
  let side = poolSide,
    size = side * SHADOW_PAGE;
  const records = new Float32Array(MAX_SHADOW_SLICES * SHADOW_RECORD_FLOATS);
  const words = new Int32Array(records.buffer);
  const facePacked = new Float32Array((MAX_SHADOW_REGIONS * faceStride) / 4);
  const toPush = new Uint8Array(MAX_SHADOW_SLICES);
  const set = (slice: number, at: number, value: number) => {
    const index = slice * SHADOW_RECORD_FLOATS + at;
    if (Object.is(records[index], Math.fround(value))) return;
    records[index] = value;
    toPush[slice] = 1;
  };
  const setInt = (slice: number, at: number, value: number) => {
    const index = slice * SHADOW_RECORD_FLOATS + at;
    if (words[index] === value) return;
    words[index] = value;
    toPush[slice] = 1;
  };
  return {
    records,
    facePacked,
    /** The pool the pages land in has `poolSide` pages a layer side from now on. */
    setPoolSide(poolSide: number) {
      side = poolSide;
      size = side * SHADOW_PAGE;
    },
    /**
     * Region `index`: its page's matrix — the page's own projection, which the viewport lands on
     * physical page `phys` —, that page's atlas rectangle, and the light envelope the depth pass
     * strips (a zero radius strips nothing).
     */
    writePage(
      index: number,
      matrices: Float32Array,
      matrixBase: number,
      phys: number,
      center: readonly number[] | undefined,
      radius: number,
    ) {
      const uniform = (index * faceStride) / 4;
      for (let i = 0; i < 16; i++) facePacked[uniform + i] = matrices[matrixBase + i];
      const local = phys % (side * side);
      facePacked[uniform + 16] = ((local % side) * SHADOW_PAGE) / size;
      facePacked[uniform + 17] = (Math.floor(local / side) * SHADOW_PAGE) / size;
      facePacked[uniform + 18] = SHADOW_PAGE / size;
      facePacked[uniform + 19] = SHADOW_PAGE;
      facePacked[uniform + 20] = center ? center[0] : 0;
      facePacked[uniform + 21] = center ? center[1] : 0;
      facePacked[uniform + 22] = center ? center[2] : 0;
      facePacked[uniform + 23] = center ? radius : 0;
    },
    /** A lamp's record: its face matrices, face count, tangent half-field, near plane, table base. */
    writeLamp(
      slice: number,
      matrices: Float32Array,
      faces: number,
      tanHalfFov: number,
      near: number,
      tableBase: number,
    ) {
      for (let i = 0; i < faces * 16; i++) set(slice, i, matrices[i]);
      set(slice, SHADOW_RECORD_INFO, faces);
      set(slice, SHADOW_RECORD_INFO + 1, tanHalfFov);
      set(slice, SHADOW_RECORD_INFO + 2, near);
      set(slice, SHADOW_RECORD_INFO + 3, tableBase);
    },
    /** A sun's record: its light-plane frame and depth range, its windows, its levels. */
    writeSun(slice: number, sun: SunLevels, levels: number, tableBase: number) {
      for (let row = 0; row < 3; row++) {
        for (let a = 0; a < 3; a++)
          set(slice, SHADOW_RECORD_FRAME + row * 4 + a, sun.frame[slice * 9 + row * 3 + a]);
        set(slice, SHADOW_RECORD_FRAME + row * 4 + 3, row < 2 ? sun.depth[slice * 2 + row] : 0);
      }
      for (let i = 0; i < levels * 2; i++)
        setInt(slice, SHADOW_RECORD_ORIGINS + i, sun.origins[slice * levels * 2 + i]);
      set(slice, SHADOW_RECORD_INFO, levels);
      set(slice, SHADOW_RECORD_INFO + 1, sun.finest[slice]);
      set(slice, SHADOW_RECORD_INFO + 2, 0);
      set(slice, SHADOW_RECORD_INFO + 3, tableBase);
    },
    /** A slice no light holds: the shading reads no shadow there. */
    clear(slice: number) {
      set(slice, SHADOW_RECORD_INFO, 0);
    },
    /** Records written since the last flush, each once; the flags drop as they are visited. */
    flush(write: (slice: number) => void) {
      for (let slice = 0; slice < MAX_SHADOW_SLICES; slice++) {
        if (!toPush[slice]) continue;
        toPush[slice] = 0;
        write(slice);
      }
    },
  };
}
