/**
 * THE RUNTIME CUTTER: drawn triangles cut into engine pages, off the main thread.
 *
 * What runs here touches no platform object — no URL, no DOM, no host library — but the SDK
 * module, which builds each cluster's normal cone (`cutCones.ts`); so the page worker runs it
 * (`page/decode/task.ts`, op `cut`) and the main thread runs the same function when no worker
 * lives. The triangles travel as one buffer (`packDrawn`), and the pages come back as
 * bytes with their descriptors and digests: serving them at an address is the caller's.
 */
import { encodeGeometryPage, UV_EXPONENT } from '../../../../page-codec/geometryPage.ts';
import { gridExponentFor } from '../../../../page-codec/pageGrids.ts';
import type { PageAttributes } from '../../../../page-codec/pageAttributes.ts';
import { boxEmpty, boxExpandByPoint } from '../../../../sdk-core/src/math/primitives/box.ts';
import { sphereFromBounds } from '../../../../sdk-core/src/math/primitives/sphere.ts';
import type { PageCutPage, PageCutPayload } from '../../../../sdk-core/src/page/decodeContracts.ts';
import type { DrawnTriangles } from '../../../../sdk-core/src/world/geometry/drawn.ts';
import { sha256Hex } from '../../measurement/sha256Hex.ts';
import { clusterCones } from './cutCones.ts';

/** A cluster holds at most this many triangles and vertices: the page format's cluster, the one
 *  the compiler cuts (`docs/FORMAT.md`). */
const CLUSTER_TRIANGLES = 128,
  CLUSTER_VERTICES = 255;

/** Whether the cut pages of `drawn` keep their normal cone: not a line's quads, which the rasters
 *  widen on screen, nor a sprite's, which they turn to the camera — what those face is not what
 *  was cut, so a cone of the cut triangles would cull them wrongly. */
export const drawnCones = (drawn: DrawnTriangles) =>
  !drawn.lines && drawn.spriteRadius === undefined;

/** Drawn triangles as one buffer: five lengths, whether their pages keep a cone (`drawnCones`),
 *  then the five arrays, every one four-byte wide. */
export function packDrawn(drawn: DrawnTriangles): ArrayBuffer {
  const parts = [drawn.positions, drawn.normals, drawn.uvs, drawn.colors, drawn.indices];
  const lengths = parts.map((part) => part?.length ?? 0);
  const packed = new Uint32Array(6 + lengths.reduce((a, b) => a + b, 0));
  packed.set(lengths);
  packed[5] = Number(drawnCones(drawn));
  let at = 6;
  for (const part of parts)
    if (part) {
      packed.set(new Uint32Array(part.buffer, part.byteOffset, part.length), at);
      at += part.length;
    }
  return packed.buffer;
}

/** The triangles `packDrawn` wrote, as views on its buffer, and whether their pages keep a cone. */
export function unpackDrawn(buffer: ArrayBuffer): { drawn: DrawnTriangles; cones: boolean } {
  const lengths = new Uint32Array(buffer, 0, 5),
    cones = new Uint32Array(buffer, 20, 1)[0] === 1;
  let at = 24;
  const take = <T>(make: (b: ArrayBuffer, offset: number, length: number) => T, i: number) => {
    const view = lengths[i] ? make(buffer, at, lengths[i]) : null;
    at += lengths[i] * 4;
    return view;
  };
  const float = (b: ArrayBuffer, offset: number, length: number) =>
    new Float32Array(b, offset, length);
  const drawn = {
    positions: take(float, 0)!,
    normals: take(float, 1)!,
    uvs: take(float, 2),
    colors: take(float, 3),
    indices: take((b, offset, length) => new Uint32Array(b, offset, length), 4)!,
  };
  return { drawn, cones };
}

/**
 * Cuts drawn triangles into single-level clusters of the format's size, in index order, each
 * written as its index page and its quantized geometry page (`encodeGeometryPage`), with no
 * simplification — every cluster is a root, drawn as it is — and, when `cones` holds, with the
 * cone of its triangles' normals (`cutCones.ts`). The position grid is the one the
 * compiler takes from the primitive's own extent: 2^16 steps across its widest axis. Texture
 * coordinates sit on the format's 2^-14, or on the finest grid the widest cluster's range fits
 * when it does not — a dashed line's distance along it (`drawn.ts`) spans past 1024 units on a
 * long line: every page is cut, none refused, and each coordinate stays within a 32-bit float's
 * own step of that range.
 */
export async function cutDrawnTriangles(
  drawn: DrawnTriangles,
  cones = drawnCones(drawn),
): Promise<PageCutPayload> {
  const { positions, normals, uvs, colors, indices } = drawn;
  const bounds = new Float64Array(6);
  boxEmpty(bounds, 0);
  for (let i = 0; i + 2 < positions.length; i += 3)
    boxExpandByPoint(bounds, 0, positions[i], positions[i + 1], positions[i + 2]);
  const extent = Math.max(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]);
  const positionExponent = Math.ceil(Math.log2(extent > 0 ? extent : 1)) - 16;
  const attributes: PageAttributes = {
    POSITION: { itemSize: 3, array: positions },
    NORMAL: { itemSize: 3, array: normals },
    ...(uvs ? { TEXCOORD_0: { itemSize: 2, array: uvs } } : {}),
    ...(colors ? { COLOR_0: { itemSize: 4, array: colors } } : {}),
  };
  const ranges = [...clusters(indices, positions.length / 3)];
  const uvExponent = uvs
    ? gridExponentFor(widestUvSpan(uvs, indices, ranges), UV_EXPONENT)
    : UV_EXPONENT;
  const built = cones ? await clusterCones(positions, indices, ranges) : null;
  const cut = [];
  let maxPositionError = 0;
  for (const [start, end] of ranges) {
    const corners = indices.slice(start, end);
    const page = encodeGeometryPage(corners, attributes, positionExponent, uvExponent);
    maxPositionError = Math.max(maxPositionError, page.quantizationError);
    const box = new Float64Array(6);
    boxEmpty(box, 0);
    for (const v of corners)
      boxExpandByPoint(box, 0, positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    const sphere = new Float64Array(4);
    sphereFromBounds(sphere, 0, box[0], box[1], box[2], box[3], box[4], box[5]);
    cut.push({ start, corners, page, box, sphere, geometry: page.data.slice().buffer });
  }
  const pages: PageCutPage[] = await Promise.all(
    cut.map(async ({ start, corners, page, box, sphere, geometry }, k) => ({
      index: corners.buffer,
      geometry,
      indexSha256: await sha256Hex(corners.buffer),
      geometrySha256: await sha256Hex(geometry),
      count: corners.length,
      start,
      min: Array.from(box.subarray(0, 3)),
      max: Array.from(box.subarray(3)),
      sphere: Array.from(sphere),
      vertexCount: page.vertexCount,
      indexCount: page.indexCount,
      flags: page.flags,
      uncompressedBytes: page.uncompressedBytes,
      ...(built ? { cone: built[k] } : {}),
    })),
  );
  return { pages, positionExponent, uvExponent, maxPositionError };
}

/** The widest range of either texture coordinate over the corners of one cluster. */
function widestUvSpan(uvs: Float32Array, indices: Uint32Array, ranges: [number, number][]) {
  let widest = 0;
  for (const [start, end] of ranges)
    for (let c = 0; c < 2; c++) {
      let lo = Infinity,
        hi = -Infinity;
      for (let i = start; i < end; i++) {
        const value = uvs[indices[i] * 2 + c];
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
      widest = Math.max(widest, hi - lo);
    }
  return widest;
}

/** Index ranges of consecutive triangles, each within the cluster's triangle and vertex bounds.
 *  A vertex is marked with the number of the cluster that last took it: no set per triangle. */
function* clusters(indices: Uint32Array, vertexCount: number): Generator<[number, number]> {
  const taken = new Uint32Array(vertexCount);
  let start = 0,
    cluster = 1,
    held = 0;
  const take = (v: number) => {
    if (taken[v] === cluster) return;
    taken[v] = cluster;
    held++;
  };
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t],
      b = indices[t + 1],
      c = indices[t + 2];
    const fresh =
      Number(taken[a] !== cluster) +
      Number(taken[b] !== cluster && b !== a) +
      Number(taken[c] !== cluster && c !== a && c !== b);
    const full = (t - start) / 3 >= CLUSTER_TRIANGLES;
    if (full || held + fresh > CLUSTER_VERTICES) {
      yield [start, t];
      start = t;
      cluster++;
      held = 0;
    }
    take(a);
    take(b);
    take(c);
  }
  if (start < indices.length) yield [start, indices.length];
}
