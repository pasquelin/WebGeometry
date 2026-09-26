import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheManifest } from '../bench/runner/cacheManifest.ts';
import { writeObservatory } from './docs/observatory/write.ts';

interface ObservatoryDagLevel {
  triangles: number;
  errorMax: number;
}

interface ObservatoryPrimitive {
  dag: { levels: ObservatoryDagLevel[] };
}

interface ObservatoryManifest {
  sourceTriangles: number;
  simplification: boolean;
  primitives: ObservatoryPrimitive[];
}

const directory = new URL('../site/assets/gallery/signature-architecture/', import.meta.url);

test('the original observatory reproduces its source and retains distinct materials and reduced DAG levels', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'trillion3d-observatory-'));
  try {
    const gltf = await writeObservatory(temporary);
    await writeObservatory(join(temporary, 'repeat'));
    for (const name of ['geometry.gltf', 'geometry.bin', 'sky.json']) {
      const actual = await readFile(join(temporary, name));
      const expected = await readFile(join(temporary, 'repeat', name));
      const first = actual.findIndex((byte, index) => byte !== expected[index]);
      assert.ok(
        actual.equals(expected),
        `${name}: ${actual.length}/${expected.length} bytes; first difference at ${first}; ` +
          `${actual.subarray(Math.max(0, first - 4), first + 12).toString('hex')} != ` +
          expected.subarray(Math.max(0, first - 4), first + 12).toString('hex'),
      );
    }
    for (const name of ['geometry.gltf', 'sky.json'])
      assert.ok(
        (await readFile(join(temporary, name))).equals(
          await readFile(new URL(`source/${name}`, directory)),
        ),
        `source ${name} reproduces exactly across platforms`,
      );
    const bytes = await readFile(join(temporary, 'geometry.bin'));
    const reference = await readFile(new URL('source/geometry.bin', directory));
    assert.equal(bytes.length, reference.length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let triangles = 0;
    const materialIds = new Set<number>();
    for (const primitive of gltf.meshes[0].primitives) {
      materialIds.add(primitive.material);
      const positions = gltf.accessors[primitive.attributes.POSITION];
      const normals = gltf.accessors[primitive.attributes.NORMAL];
      const indices = gltf.accessors[primitive.indices];
      const indexOffset = gltf.bufferViews[indices.bufferView].byteOffset;
      for (const accessor of [positions, indices]) {
        const buffer = gltf.bufferViews[accessor.bufferView];
        const start = buffer.byteOffset,
          end = start + buffer.byteLength;
        assert.ok(
          bytes.subarray(start, end).equals(reference.subarray(start, end)),
          'source positions and topology reproduce byte for byte across platforms',
        );
      }
      assert.equal(normals.count, positions.count);
      triangles += indices.count / 3;
      for (let i = 0; i < indices.count; i++)
        assert.ok(
          view.getUint32(indexOffset + i * 4, true) < positions.count,
          'source index is in range',
        );
      for (const accessor of [positions, normals]) {
        const offset = gltf.bufferViews[accessor.bufferView].byteOffset;
        for (let i = 0; i < accessor.count * 3; i++) {
          const componentOffset = offset + i * 4;
          const value = view.getFloat32(componentOffset, true);
          assert.ok(Number.isFinite(value), 'source attributes are finite');
          // Finite-difference normals differ by 1.64e-11 between macOS and Linux libm.
          if (accessor === normals)
            assert.ok(
              Math.abs(value - reference.readFloatLE(componentOffset)) <= 1e-9,
              `normal component ${i} differs beyond 1e-9 at byte ${componentOffset}`,
            );
        }
      }
      // #716: every vertex carries a unit normal, the poles where a patch's columns meet too.
      const normalOffset = gltf.bufferViews[normals.bufferView].byteOffset;
      for (let i = 0; i < normals.count; i++) {
        const at = normalOffset + i * 12;
        const length = Math.hypot(
          view.getFloat32(at, true),
          view.getFloat32(at + 4, true),
          view.getFloat32(at + 8, true),
        );
        assert.ok(
          Math.abs(length - 1) < 1e-6,
          `normal ${i} of material ${primitive.material}: length ${length}`,
        );
      }
    }
    assert.equal(triangles, 91352);
    assert.equal(materialIds.size, 6);
    assert.equal(
      new Set(gltf.materials.map((m) => m.pbrMetallicRoughness.baseColorFactor.join())).size,
      6,
    );
    const full = fileURLToPath(new URL('cache/native/full/', directory));
    const manifest = (await readCacheManifest(full)).manifest as unknown as ObservatoryManifest;
    assert.equal(manifest.sourceTriangles, triangles);
    assert.equal(manifest.simplification, true);
    assert.equal(manifest.primitives.length, materialIds.size);
    const curved = manifest.primitives.filter((primitive) => primitive.dag.levels.length > 1);
    assert.equal(curved.length, 4);
    for (const primitive of curved) {
      const levels = primitive.dag.levels;
      assert.ok(
        levels[levels.length - 1].triangles < levels[0].triangles / 2,
        'curved surfaces really simplify',
      );
      assert.ok(
        levels[levels.length - 1].errorMax > 0,
        'LOD thresholds have a nonzero geometric witness',
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
