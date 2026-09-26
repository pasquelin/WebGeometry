// The two proofs every published gallery scene carries (`docs-gallery.ts` writes them): its source
// rebuilt byte for byte by its recipe, and its cache manifest read back.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readCacheManifest } from '../../bench/runner/cacheManifest.ts';

/** Asserts that `write`, run in a throwaway folder, rebuilds the published source byte for byte. */
export async function assertSourceReproduced(
  published: string,
  prefix: string,
  write: (directory: string) => Promise<void>,
) {
  const temporary = await mkdtemp(join(tmpdir(), prefix));
  try {
    await write(temporary);
    for (const file of ['geometry.gltf', 'geometry.bin'])
      assert.deepEqual(
        await readFile(join(temporary, file)),
        await readFile(join(published, 'source', file)),
      );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Shape of one native compiler cache manifest, as persisted on disk. */
export interface CacheManifest {
  sourceTriangles: number;
  selectedTriangles: number;
  primitives: unknown[];
  scenePlugin: { name: string };
}

/** The cache manifest a published scene's full pass points at. */
export async function publishedManifest(published: string): Promise<CacheManifest> {
  const { manifest } = await readCacheManifest(resolve(published, 'cache/native/full'));
  return manifest as unknown as CacheManifest;
}
