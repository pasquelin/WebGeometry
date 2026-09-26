import type { Page, Primitive } from '../../../../sdk-core/src/index.ts';
import { LINE_DEPTH_LAYER } from '../../../../sdk-core/src/lod/depthLayer.ts';
import type { PageCutPayload } from '../../../../sdk-core/src/page/decodeContracts.ts';
import { cutPagesOffThread } from '../../page/decode/host.ts';

/** A runtime primitive, and the addresses its pages are served from until it is released. */
export type RuntimePrimitive = { primitive: Primitive; urls: string[] };

/** Bytes served at an address of their own, with the digest the page reader checks. */
function served(bytes: ArrayBuffer, sha256: string, urls: string[]) {
  const url = URL.createObjectURL(new Blob([bytes]));
  urls.push(url);
  return { url, sha256, bytes: bytes.byteLength };
}

/** What the cut triangles are, beside faces (`DrawnTriangles`). */
type DrawnKind = { lines?: boolean; spriteRadius?: number };

/** The box and ball of a page: its own, or for a sprite's quad, which the rasters turn to face
 *  the camera about its origin (`drawnSprite`), the cube and ball of its radius there — what
 *  holds the quad whichever way it turns, as the reference culls a sprite by that ball. */
function bounds(page: PageCutPayload['pages'][number], radius: number | undefined) {
  if (radius === undefined) return { min: page.min, max: page.max, sphere: page.sphere };
  return {
    min: [-radius, -radius, -radius],
    max: [radius, radius, radius],
    sphere: [0, 0, 0, radius],
  };
}

/** The pages of a cut, served at addresses of their own: the primitive a manifest lists. The
 *  pages of line quads draw one coplanar layer over the faces they lie on (`LINE_DEPTH_LAYER`).
 *  Each keeps the cone of its triangles' normals, but a line's quads, widened on screen, and a
 *  sprite's, turned to the camera: what they face is not what was cut. */
function servePrimitive(cut: PageCutPayload, kind: DrawnKind): RuntimePrimitive {
  const urls: string[] = [];
  const coned = !kind.lines && kind.spriteRadius === undefined;
  const pages: Page[] = cut.pages.map((page, id) => ({
    id,
    ...served(page.index, page.indexSha256, urls),
    count: page.count,
    ...bounds(page, kind.spriteRadius),
    role: 'exact',
    start: page.start,
    level: 0,
    lodError: 0,
    parentError: null,
    parentSphere: null,
    group: null,
    source: null,
    ...(kind.lines ? { depthLayer: LINE_DEPTH_LAYER } : {}),
    ...(coned && page.cone ? { cone: page.cone } : {}),
    geometry: {
      ...served(page.geometry, page.geometrySha256, urls),
      vertexCount: page.vertexCount,
      indexCount: page.indexCount,
      flags: page.flags,
      uncompressedBytes: page.uncompressedBytes,
    },
  }));
  const primitive: Primitive = {
    mesh: 0,
    primitive: 0,
    pass: 'exact-clusters',
    clusterStrategy: 'dag-groups',
    pages,
    structure: { version: 1, roots: pages.map((page) => page.id), groups: [] },
    quantization: {
      positionExponent: cut.positionExponent,
      uvExponent: cut.uvExponent,
      maxPositionError: cut.maxPositionError,
    },
  };
  return { primitive, urls };
}

/**
 * Cuts drawn triangles, packed by `packDrawn` and yielded, into engine pages at run time — in the page worker, where one lives, by
 * the same function on the main thread otherwise (`runtimeCut.ts`) — and serves them. The pages
 * then enter the session like a compiled model's: read by the streamer at their address, held
 * in the same pools under the same budgets, evicted by the same rules.
 */
export async function cutRuntimePrimitive(
  packed: ArrayBuffer,
  kind: DrawnKind,
): Promise<RuntimePrimitive> {
  return servePrimitive(await cutPagesOffThread(packed), kind);
}
