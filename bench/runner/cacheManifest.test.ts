import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest } from '../../tests/fixtures/manifestBinary.ts';
import { writePagedManifest } from '../../tests/fixtures/pagedManifest.ts';
import { cacheHoldsBlend } from './cacheManifest.ts';

/** A cache folder as the compiler publishes it: the pointer, then the paged manifest it names. */
async function cache(t: test.TestContext, pass: string) {
  const full = await mkdtemp(join(tmpdir(), 'cache-manifest-'));
  t.after(() => rm(full, { recursive: true, force: true }));
  const paged = manifest();
  paged.primitives[paged.primitives.length - 1].pass = pass;
  await writePagedManifest(join(full, 'k'), paged);
  await writeFile(join(full, 'manifest.json'), JSON.stringify({ url: 'k/clusters.json' }));
  return full;
}

test('a transparent primitive is found through the pages, the root listing none', async (t) => {
  const full = await cache(t, 'clustered-blend');
  const root = JSON.parse(await readFile(join(full, 'k/clusters.json'), 'utf8'));
  assert.equal(root.primitives, undefined, 'the root holds no primitive');
  assert.equal(await cacheHoldsBlend(full), true);
  assert.equal(await cacheHoldsBlend(await cache(t, 'exact-clusters')), false);
});
