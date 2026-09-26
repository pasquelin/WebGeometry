// The manifest of a compiled cache — pointer, root, pages and their column files — decoded whole,
// and the directory its files live in.
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readPagedManifest } from '../../packages/sdk-core/src/manifest/paged.ts';

/** The pointer `manifest.json`, naming the root `clusters.json` to read next to it. */
interface ManifestPointer {
  url: string;
}

/** `full` is `<cache>/native/full`, the directory of the pointer `manifest.json`. */
export async function readCacheManifest(full: string) {
  const pointer = JSON.parse(readFileSync(join(full, 'manifest.json'), 'utf8')) as ManifestPointer;
  const rootPath = join(full, pointer.url),
    dir = dirname(rootPath);
  const root = JSON.parse(readFileSync(rootPath, 'utf8')) as Record<string, unknown>;
  return { dir, manifest: await readPagedManifest(root, (page) => readFile(join(dir, page.url))) };
}
