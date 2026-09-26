/** The manifest as a page tree (`compiler_manifest_pages.rs`, FORMAT.md): the fixed-size root
 *  `clusters.json`, its head page (every other field, the previews' sidecar) and its mesh pages
 *  (slim primitives, their sidecar), read through the scene partition's pager (`tablePartition.ts`). */
import { EngineError, type ClusterManifest } from '../contracts/index.ts';
import { named, readLeaves, type PageKind } from '../scene/core/tablePartition.ts';
import { decodeManifestBinary } from './binaryDecode.ts';
import { MANIFEST_BINARY_VERSION } from './binaryFormat.ts';
import { assertManifestBinary, type SlimClusterManifest } from './binaryTypes.ts';

/** The manifest's pages: a mesh page lists its slim primitives. */
const MANIFEST_PAGES: PageKind = {
  prefix: 'manifest-page-',
  version: MANIFEST_BINARY_VERSION,
  records: 'primitives',
  unsupported: 'UNSUPPORTED_FORMAT',
  invalid: 'INVALID_CACHE',
};

/** The bytes of `view` as a buffer of their own. */
const buffer = (view: Uint8Array): ArrayBuffer =>
  view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? (view.buffer as ArrayBuffer)
    : (view.slice().buffer as ArrayBuffer);

/**
 * The manifest under `root`, its pages and their sidecars read side by side through `read` — in a
 * browser `fetchVerified`, which proves each by the size and fingerprint that name it: the root's
 * fields, the head's, and the primitives of every mesh page in order (`decodeManifestBinary`).
 */
export async function readPagedManifest(
  root: Record<string, unknown>,
  read: (page: { url: string; bytes: number; sha256: string }) => Promise<Uint8Array>,
): Promise<ClusterManifest> {
  const { head, pages, ...fixed } = root;
  if (!Array.isArray(pages) || !named(MANIFEST_PAGES, [head]).length)
    throw new EngineError('INVALID_CACHE', 'the manifest root names no head page or no pages', {});
  // The head first, then the mesh pages in order, all read side by side.
  const bodies = await readLeaves(MANIFEST_PAGES, named(MANIFEST_PAGES, [head, ...pages]), read);
  const [first, ...meshes] = await Promise.all(
    bodies.map(async (body) => {
      assertManifestBinary(body.binary);
      return { body, bytes: buffer(await read(body.binary)) };
    }),
  );
  const { version: _version, binary: _binary, primitives: _none, ...top } = first.body;
  const [whole, ...parts] = [first, ...meshes].map(({ body: { primitives, binary }, bytes }) =>
    decodeManifestBinary({ ...fixed, ...top, primitives, binary } as SlimClusterManifest, bytes),
  );
  return { ...whole, primitives: parts.flatMap((part) => part.primitives) };
}
