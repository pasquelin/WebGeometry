import test from 'node:test';
import assert from 'node:assert/strict';
import { manifest, TEMPLATES } from '../../../../tests/fixtures/manifestBinary.ts';
import { EMPTY, pagedManifest } from '../../../../tests/fixtures/pagedManifest.ts';
import type { EngineError } from '../contracts/index.ts';
import { decodeManifestBinary, encodeManifestBinary } from './binary.ts';
import { readPagedManifest } from './paged.ts';

/** The manifest one column file gave, before the manifest was paged. */
function whole() {
  const { manifest: slim, binary } = encodeManifestBinary(manifest(), TEMPLATES);
  return decodeManifestBinary(
    { ...slim, binary: { ...slim.binary, sha256: 'f' } },
    binary.buffer as ArrayBuffer,
  );
}

for (const index of [false, true])
  test(`the paged manifest reads back what one column file gave${index ? ', through an index page' : ''}`, async () => {
    const { root, files } = pagedManifest(manifest(), index);
    const read = async ({ url }: { url: string }) => files.get(url)!;
    assert.deepEqual(await readPagedManifest(root, read), whole());
  });

test('a root that names no head page is refused', async () => {
  const { root, files } = pagedManifest(manifest());
  const refused = readPagedManifest({ ...root, head: EMPTY }, async ({ url }) => files.get(url)!);
  await assert.rejects(refused, (error: EngineError) => error.code === 'INVALID_CACHE');
});
