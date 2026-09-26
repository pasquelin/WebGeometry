// A manifest laid out as the compiler pages it (`compiler_manifest_pages.rs`), in memory: the root
// `clusters.json` holds, and every page and column file under it by name.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClusterManifest } from '../../packages/sdk-core/src/contracts/index.ts';
import {
  encodeManifestBinary,
  MANIFEST_BINARY_VERSION,
} from '../../packages/sdk-core/src/index.ts';
import { TEMPLATES } from './manifestBinary.ts';

/** An empty slot of a root or an index page. */
export const EMPTY = '0'.repeat(168);

/** `manifest`'s root and files: a head page, one mesh page — under an index page when `index`. */
export function pagedManifest(manifest: ClusterManifest, index = false) {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const put = (bytes: Uint8Array<ArrayBuffer>, extension: string) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const url = `manifest-page-${sha256}.${extension}`;
    files.set(url, bytes);
    return { sha256, bytes: bytes.byteLength, url };
  };
  const slot = (body: object) => {
    const page = put(new TextEncoder().encode(JSON.stringify(body)), 'json');
    return `${page.sha256}${page.bytes.toString(16).padStart(8, '0')}${'0'.repeat(96)}`;
  };
  const columns = (part: object) => {
    const { manifest: slim, binary } = encodeManifestBinary(part as ClusterManifest, TEMPLATES);
    return {
      ...slim,
      version: MANIFEST_BINARY_VERSION,
      binary: { ...slim.binary, ...put(binary as Uint8Array<ArrayBuffer>, 'bin') },
    };
  };
  const { schema, formatVersion, status, scope, primitives, ...top } = manifest;
  const head = columns({ ...top, primitives: [] });
  let mesh = slot(columns({ primitives }));
  if (index) mesh = slot({ version: MANIFEST_BINARY_VERSION, pages: [mesh, EMPTY] });
  const pages = [mesh, ...Array<string>(7).fill(EMPTY)];
  return { root: { schema, formatVersion, status, scope, head: slot(head), pages }, files };
}

/** Writes `m` paged into `dir`, its root as `file`. */
export async function writePagedManifest(dir: string, m: ClusterManifest, file = 'clusters.json') {
  const { root, files } = pagedManifest(m);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), JSON.stringify(root));
  for (const [name, bytes] of files) await writeFile(join(dir, name), bytes);
}
