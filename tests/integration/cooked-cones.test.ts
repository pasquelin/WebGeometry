// The WebGPU prepare posts the cone the compiler cooked (`normal_cone.rs`, #272) where it used to
// build one with `triangleCone` from the host vertices. On every compiled scene, this rebuilds that
// cone from `source.gltf` as the prepared scene views it and each index page, and requires the same
// axis bit for bit and an angle no narrower, at most twice the compiler's margin wider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCacheManifest } from '../../bench/runner/cacheManifest.ts';
import { triangleCone } from '../kit/cone.ts';
import { preparedGeometries } from '../../packages/sdk-browser/src/host/prepared/geometry.ts';
import { sceneDocument } from '../../packages/sdk-browser/src/scene/tables.ts';
import type { PreparedSceneTables } from '../../packages/sdk-core/src/scene/core/tableContracts.ts';
import { sceneCacheFiles } from '../kit/scenes/caches.ts';

const root = new URL('../../', import.meta.url);

/** The float64 words of `values`: bit for bit, and ulps apart for two numbers of one sign. */
const words = (values: number[]) =>
  Array.from(new BigUint64Array(Float64Array.from(values).buffer));
/** Ulps an angle may stand above the runtime's: twice `ANGLE_MARGIN_ULPS` (4, `normal_cone.rs`). */
const WIDEST = 2n * 4n;

/** The bytes of `file`, alone in their `ArrayBuffer`. */
const bytesOf = (file: string) => new Uint8Array(readFileSync(file)).buffer;

/** Every page of the scene cache whose pointer is `pointer`, and how many of them disagree. */
async function checkScene(pointer: string) {
  const { dir, manifest } = await readCacheManifest(dirname(fileURLToPath(new URL(pointer, root))));
  const tables = JSON.parse(
    readFileSync(join(dir, 'scene-tables.json'), 'utf8'),
  ) as PreparedSceneTables;
  // The document the WebGPU session draws: `source.gltf`, never the autonomous scene.
  const { document, bufferUrl } = sceneDocument(
    tables,
    'source.gltf',
    pathToFileURL(`${dir}/`).href,
  );
  const geometryOf = preparedGeometries(
    document,
    bufferUrl ? bytesOf(fileURLToPath(bufferUrl)) : null,
  );
  // A streaming bundle holds dozens of index pages: each is read once, and a page viewed in it.
  const bundles = new Map<string, ArrayBuffer>();
  const bundle = (url: string) =>
    bundles.get(url) ?? bundles.set(url, bytesOf(join(dir, url))).get(url)!;
  const disagreements: string[] = [];
  let pages = 0;
  for (const primitive of manifest.primitives) {
    if (!primitive.pages.length) continue;
    const position = geometryOf(primitive.mesh, primitive.primitive).attributes.position;
    // The copy the prepare made before it read cones from the cache: every accessor, element by element.
    const xyz = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      xyz[i * 3] = position.getX(i);
      xyz[i * 3 + 1] = position.getY(i);
      xyz[i * 3 + 2] = position.getZ(i);
    }
    for (const page of primitive.pages) {
      pages++;
      const held = page.stream === undefined ? undefined : primitive.streams?.pages[page.stream];
      const indices = held
        ? new Uint32Array(bundle(held.url), page.streamOffset, page.count)
        : new Uint32Array(bundle(page.url), 0, page.count);
      // A version-9 sidecar gives every page its cone.
      const built = triangleCone(xyz, indices),
        cone = page.cone!;
      const cooked = words([...cone.axis, cone.angle]),
        expected = words([...built.axis, built.angle]);
      const wider = cooked[3] - expected[3];
      if (cooked.slice(0, 3).join() !== expected.slice(0, 3).join() || wider < 0n || wider > WIDEST)
        disagreements.push(`${pointer} page ${page.id}: cooked ${JSON.stringify(page.cone)}`);
    }
  }
  return { pages, disagreements };
}

test('every cooked cone holds the cone the runtime built from the same triangles, on its axis', async () => {
  const pointers = await sceneCacheFiles('manifest.json');
  assert.ok(pointers.length > 0, 'the repository compiles its scenes before the unit suite');
  let pages = 0;
  const disagreements: string[] = [];
  for (const pointer of pointers) {
    const scene = await checkScene(pointer);
    pages += scene.pages;
    disagreements.push(...scene.disagreements);
  }
  assert.ok(pages > 0, 'the compiled scenes hold clusters');
  assert.deepEqual(disagreements.slice(0, 5), [], `${disagreements.length} of ${pages} pages`);
});
