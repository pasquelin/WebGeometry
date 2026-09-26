// What the public scenes guarantee, read off their compiled caches — no GPU, no browser, seconds.
//
// The bench and the proofs run on models anybody can fetch (`bench/runner/assets.ts`), so the
// claims made about them have to be checkable by anybody too. This probe opens the caches and
// asserts what each scene is kept for:
//
//   - `sponza` and a generated facade: a cut with something to choose from — every primitive that
//     holds more than one cluster coarsens above level 0, and the coarsest level covers it;
//   - `normal-tangent-mirror-test`: mirrored texture coordinates cost the simplification nothing —
//     the fold is continuous in (position, uv), so the welded halves stay manifold, no vertex is
//     locked and the DAG still reaches a root.
//
// It reads the caches `node bench/runner/assets.ts` writes and never compiles anything itself:
// a missing cache fails here by name, with the command that produces it.
//
// node --experimental-strip-types --test tests/browser/probes/public-scenes.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readCacheManifest } from '../../../bench/runner/cacheManifest.ts';
import { ASSETS, sceneDerived } from '../../../bench/runner/scene.ts';

/**
 * The compile report a primitive carries beside the runtime contract: the engine consumes its
 * `warnings` alone (`packages/sdk-core/src/contracts/dag.ts`), the rest is what the cook wrote down
 * about the hierarchy it built, and what a proof about the shape of a DAG has to read.
 */
interface DagLevels {
  depth?: number;
  levels?: { level: number; clusters: number; triangles: number; roots: number }[];
  warnings?: { code: string; roots: number; pages: number }[];
}

const FACADE = /^facade-.+-derived$/;

/** The facade caches on disk, newest seed last; empty when none was generated. */
function facadeScenes() {
  if (!existsSync(ASSETS)) return [];
  return readdirSync(ASSETS)
    .filter((name) => FACADE.test(name))
    .sort()
    .map((name) => name.slice(0, -'-derived'.length));
}

async function openScene(scene: string) {
  const full = join(sceneDerived(scene), 'native/full');
  assert.ok(
    existsSync(join(full, 'manifest.json')),
    `no cache for ${scene}: run \`node bench/runner/assets.ts --only ${scene}\`` +
      ' (a facade is written first by `node bench/runner/scenes/facade.ts --seed <n>`)',
  );
  return (await readCacheManifest(full)).manifest;
}

const MIRROR = 'normal-tangent-mirror-test';

/** The scenes this proof reads: those whose cut must have something to choose from, and the
 *  mirrored one. A machine without a facade is told how to write one rather than proving less. */
function provenScenes() {
  const facades = facadeScenes();
  assert.ok(
    facades.length > 0,
    'no facade scene on disk: run `node bench/runner/scenes/facade.ts --seed 7`' +
      ' then `node bench/runner/assets.ts --only facade-7`',
  );
  return { cut: ['sponza', facades[facades.length - 1]], mirror: MIRROR };
}

test('every scene the bench names opens from its compiled cache', async () => {
  const { cut, mirror } = provenScenes();
  for (const scene of [...cut, mirror]) {
    const manifest = await openScene(scene);
    assert.equal(manifest.status, 'ready', `${scene}: cache not ready`);
    assert.ok(manifest.primitives.length > 0, `${scene}: no primitive`);
    assert.ok(
      (manifest.selectedTriangles ?? 0) > 0,
      `${scene}: the cache selected no triangle at all`,
    );
  }
});

test('a primitive with more than one cluster coarsens above level 0', async () => {
  for (const scene of provenScenes().cut) {
    const manifest = await openScene(scene);
    let climbing = 0;
    for (const primitive of manifest.primitives) {
      const dag = primitive.dag as DagLevels | null | undefined;
      const levels = dag?.levels ?? [];
      assert.ok(levels.length > 0, `${scene}: a primitive carries no DAG report`);
      // A primitive already made of one cluster has nothing to coarsen; every other one must.
      if (levels[0].clusters <= 1) continue;
      assert.ok(
        (dag?.depth ?? 0) >= 1,
        `${scene}: a primitive of ${levels[0].clusters} clusters stayed flat`,
      );
      assert.ok(
        levels[levels.length - 1].roots >= 1,
        `${scene}: the coarsest level of a primitive covers nothing`,
      );
      climbing++;
    }
    assert.ok(climbing > 0, `${scene}: no primitive holds more than one cluster`);
  }
});

test('mirrored texture coordinates cost the simplification nothing', async () => {
  const manifest = await openScene(MIRROR);
  assert.equal(manifest.primitives.length, 1, 'the mirror scene is one primitive');
  const [primitive] = manifest.primitives;
  const dag = primitive.dag as DagLevels | null | undefined;
  assert.deepEqual(dag?.warnings ?? [], [], 'the mirrored halves stopped the coarsening');
  assert.ok((dag?.depth ?? 0) >= 1, 'the mirrored plane never left level 0');
  const topology = primitive.topology;
  assert.ok(topology, 'the cache published no topology for the mirror scene');
  // The fold is continuous in (position, uv): the weld joins the two halves instead of splitting
  // them, so nothing along the mirror is locked and no edge of it is seen twice.
  assert.equal(topology.edges.nonManifold, 0, 'the mirror fold left a non-manifold edge');
  assert.equal(topology.vertices.locked, 0, 'the mirror fold locked a vertex');
  assert.equal(topology.manifold, true, 'the welded mirror plane is not manifold');
});
