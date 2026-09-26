import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CommandWriter,
  DEFAULT_MATTER,
  DEFAULT_PHYSICS_BUDGET,
  HIT_WORDS,
  PHYSICS_MATERIALS,
  SHAPE,
  type BodyRecord,
} from '../../../sdk-core/src/physics/index.ts';
import { Ray } from '../../../sdk-core/src/world/math/volumes.ts';
import { Vector3 } from '../../../sdk-core/src/world/math/vector3.ts';
import { body, castDown, startModule } from './module.fixture.ts';
import { physicsRaycast } from './raycast.ts';
import type { PhysicsSession } from './session.ts';
import { cooked, landed, place, streamedModel, tile } from './tiles.fixture.ts';

/** The golden tile the compiler's cook writes (`physics_cook/tests.rs`): a 2 × 2 m quad rising
 *  from (0, 0) to (2, 1) along x, in native Jolt's binary state. */
const golden = () =>
  readFile(new URL('../../../../tests/fixtures/physics/ramp-tile.bin', import.meta.url));

test('a tile cooked by native Jolt is restored in the module, collides, and answers a ray exactly', async () => {
  const jolt = await startModule();
  const writer = new CommandWriter();
  writer.gravity([0, -9.81, 0]);
  writer.restore(0, new Uint8Array(await golden()));
  writer.add({ ...body(0, 0, 0, 1), shape: SHAPE.cooked, size: [1, 1, 1], indices: [0] });
  writer.release(0);
  writer.add({ ...body(1, 2, 3, 0.25), position: [1, 3, 0.7] });
  jolt.step(writer.take(), 0);
  const hit = castDown(jolt, 1);
  const f = new Float32Array(hit.buffer);
  assert.equal(hit[0], 0, 'the ramp is hit');
  // The ramp's height at x = 1 is 0.5: the exact triangle, not a box around it.
  assert.ok(Math.abs(f[3] - 0.5) < 1e-4, `hit at y = ${f[3]}`);
  assert.ok(f[5] < 0 && f[6] > 0.8, 'the normal leans back along the slope');
  for (let s = 0; s < 30; s++) jolt.step(null, 1 / 60);
  assert.equal(castDown(jolt, 3)[0], 0xffffffff, 'past the ramp, nothing');
});

/** A model whose `physics.json` is `file`, streamed in around the origin within `memoryBytes`:
 *  its streamer, the bodies it added, the errors raised and the files fetched. */
async function streamed(file: object, memoryBytes = DEFAULT_PHYSICS_BUDGET.memoryBytes) {
  const { tiles, model, writer, bodies, errors, fetched } = await streamedModel(
    file,
    await golden(),
    { memoryBytes },
  );
  const added: BodyRecord[] = [];
  const add = writer.add.bind(writer);
  // The pose is scratch the streamer reuses: copied as it goes by.
  writer.add = (record) => (
    added.push({ ...record, position: Array.from(record.position) }),
    add(record)
  );
  tiles.update([0, 0, 0], 1000);
  await landed();
  const hit = new Uint32Array(HIT_WORDS);
  const session = { cast: async () => hit, objectOf: tiles.modelOf, materialOf: tiles.materialOf };
  return {
    tiles,
    model,
    added,
    errors,
    fetched,
    bodies,
    hit,
    session: session as unknown as PhysicsSession,
  };
}

const down = new Ray(new Vector3(1, 5, 0), new Vector3(0, -1, 0));

test('tiles past the collision share wait, never refused: the nearest in, the farthest out for them', async () => {
  const collider = { kind: 'mesh', tiles: [tile(0), tile(10), tile(20)] };
  // A share of 4 bytes: two of the three two-byte tiles.
  const { tiles, errors, fetched, bodies, hit, session, model, added } = await streamed(
    cooked([collider], [place(0)]),
    8,
  );
  assert.deepEqual(errors, [], 'nothing refused');
  assert.deepEqual(fetched.slice(1).sort(), ['t0.bin', 't10.bin'], 'the two nearest');
  assert.equal(bodies.count.collisionBytes, 4);
  new Float32Array(hit.buffer).set([0.25, 1, 0.5, 0, 0, 1, 0], 1);
  hit[0] = added[0].id;
  const found = await physicsRaycast(session, down, { exact: true }, 8);
  assert.equal(found?.object, model, 'a tile hit names its model');
  assert.equal(found?.distance, 2);
  await assert.rejects(physicsRaycast(null, down, { exact: true }, 8), { code: 'PHYSICS_OFF' });
  // The eye at the far end: the tile left behind leaves for the one that waited.
  tiles.update([22, 0, 0], 1000);
  await landed();
  assert.deepEqual(fetched.slice(1).sort(), ['t0.bin', 't10.bin', 't20.bin']);
  assert.deepEqual([bodies.count.collisionBytes, errors], [4, []]);
  // Back at the origin, the tile asked again is the one that left: the farthest.
  tiles.update([0, 0, 0], 1000);
  await landed();
  assert.deepEqual(fetched.slice(4), ['t0.bin']);
});

const collider = (material: number | null) => ({ kind: 'mesh', material, tiles: [tile()] });

test('an exact hit on a cooked tile names the glTF material of its collider', async () => {
  const file = cooked([collider(3), collider(5)], [place(0), place(1)]);
  const { tiles, model, hit, session, added } = await streamed(file);
  const materials: number[] = [];
  for (const { id } of added.sort((a, b) => a.position[0] - b.position[0])) {
    hit[0] = id;
    const found = await physicsRaycast(session, down, { exact: true }, 8);
    assert.equal(found?.object, model);
    materials.push(found!.material);
  }
  assert.deepEqual(materials, [3, 5], 'each tile its own material');
  assert.equal(tiles.materialOf(7), -1, 'a body that is no tile carries none');
});

test('a tile body takes the matter its node declares, else the default matter', async () => {
  const rubber = PHYSICS_MATERIALS.rubber;
  const declared = { friction: rubber.friction, restitution: rubber.restitution };
  const file = cooked([collider(null), collider(0)], [place(0, declared), place(1)]);
  const { added } = await streamed(file);
  const matter = added
    .sort((a, b) => a.position[0] - b.position[0])
    .map(({ friction, restitution }) => ({ friction, restitution }));
  const fallback = { friction: DEFAULT_MATTER.friction, restitution: DEFAULT_MATTER.restitution };
  assert.deepEqual(matter, [declared, fallback]);
});
