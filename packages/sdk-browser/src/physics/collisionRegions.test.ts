import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collisionBytesOf,
  DEFAULT_PHYSICS_BUDGET,
  TRIANGLE_BYTES,
} from '../../../sdk-core/src/physics/index.ts';
import { box } from '../../../sdk-core/src/world/geometry/basic.ts';
import { Material } from '../../../sdk-core/src/world/material/material.ts';
import { Mesh } from '../../../sdk-core/src/world/object/mesh.ts';
import { Camera } from '../../../sdk-core/src/world/camera/camera.ts';
import { Group } from '../../../sdk-core/src/world/object/object3d.ts';
import { cooked, landed, place, streamedModel, tile } from './tiles.fixture.ts';
import { createWorldPhysics } from './worldPhysics.ts';

/** Tiles of the generated scene, 10 m apart along x, and the triangles of each: 15 M in all. */
const TILES = 1500,
  TRIANGLES = 10_000;
/** How far the eye, riding the body, asks for tiles: more than the collision share holds. */
const RANGE = 3000;

/** A 15 km row of `TILES` static tiles of `TRIANGLES` triangles each, cooked once and placed once. */
const row = () =>
  cooked(
    [
      {
        kind: 'mesh',
        tiles: Array.from({ length: TILES }, (_, i) => ({
          url: `t${i}.bin`,
          sha256: 'a'.repeat(64),
          bytes: TRIANGLES * TRIANGLE_BYTES,
          triangles: TRIANGLES,
          bounds: [i * 10, 0, -5, i * 10 + 10, 1, 5],
        })),
      },
    ],
    [place(0)],
  );

test('a 15 M-triangle static scene is never refused: its tiles follow a moving body within the memory budget', async () => {
  const { tiles, scene, bodies, errors, fetched } = await streamedModel(row(), new Uint8Array(1), {
    bodies: 1024,
  });
  const share = collisionBytesOf(DEFAULT_PHYSICS_BUDGET),
    fit = Math.floor(share / (TRIANGLES * TRIANGLE_BYTES));
  assert.ok(TILES > 3 * fit, 'the scene is far past what the share holds');
  const ball = new Mesh(box(1, 1, 1), new Material('meshStandard'));
  ball.physics = 'dynamic';
  scene.add(ball);
  bodies.reconcile(new Set(), (error) => assert.fail(String(error)));
  /** The x of every resident tile's centre. */
  const resident = () =>
    Array.from({ length: 1024 }, (_, i) => bodies.slots.at(i))
      .flatMap((owner) => (owner && 'tile' in owner ? [owner.tile.tile.bounds[0] + 5] : []))
      .sort((a, b) => a - b);
  /** The body at `x`, the eye riding it or left behind: updates until one asks no tile. */
  const settleAt = async (x: number, eye = [x, 0.5, 0], range = RANGE) => {
    ball.position.set(x, 0.5, 0);
    ball.updateMatrixWorld(true);
    for (let asked = -1, rounds = 0; asked !== fetched.length; await landed()) {
      assert.ok(++rounds < TILES, 'the tiles settle: a stream that never stops fails, not hangs');
      asked = fetched.length;
      tiles.update(eye, range);
      assert.ok(bodies.count.collisionBytes <= share, `${bodies.count.collisionBytes} bytes held`);
    }
  };
  tiles.update([0, 0.5, 0], RANGE);
  assert.equal(fetched.length, 1 + 2, 'two tiles an update at most, beside physics.json');
  for (let x = RANGE + 5; x < TILES * 10; x += 2500) {
    await settleAt(x);
    const held = resident();
    assert.equal(held.length, fit, `the share full at x = ${x}`);
    assert.ok(held.includes(x), `the tile under the body at x = ${x} resident`);
    // The nearest `fit` tiles: none resident farther than the `fit`-th nearest centre.
    const far = (c: number) => Math.abs(c - x);
    const nearest = Array.from({ length: TILES }, (_, i) => far(i * 10 + 5)).sort((a, b) => a - b);
    assert.ok(Math.max(...held.map(far)) <= nearest[fit - 1], `the nearest around x = ${x}`);
  }
  // The eye left out of reach: the body alone holds tiles, the one under it, wherever it goes.
  for (const x of [7005, 1005]) {
    await settleAt(x, [-1e4, 0, 0], 0);
    assert.deepEqual(resident(), [x], `only the tile under the body at x = ${x}`);
  }
  assert.deepEqual(errors, [], 'nothing refused');
});

test('a resident tile stays until half as far again as it came in: no load and release at the edge', async () => {
  const file = cooked([{ kind: 'mesh', tiles: [tile()] }], [place(0)]);
  const { tiles, bodies, fetched } = await streamedModel(file, new Uint8Array(1));
  const heldAt = async (x: number) => {
    tiles.update([x, 0, 0], 10);
    await landed();
    return bodies.count.collisionBytes;
  };
  // The tile spans x 0 to 2: it comes in within 10 m, and leaves past 15.
  assert.deepEqual([await heldAt(11), await heldAt(16), await heldAt(18)], [2, 2, 0]);
  assert.deepEqual([await heldAt(16), fetched.length], [0, 2], 'asked once, not again at 16 m');
});

test('a tile past the whole share holds no one back: the farther tiles still load', async () => {
  const huge = { ...tile(0), url: 'huge.bin', bytes: 100 };
  const file = cooked([{ kind: 'mesh', tiles: [huge, tile(4)] }], [place(0)]);
  const { tiles, bodies, errors } = await streamedModel(file, new Uint8Array(1), {
    memoryBytes: 10,
  });
  tiles.update([0, 0, 0], 20);
  await landed();
  assert.equal(bodies.count.collisionBytes, 2, 'the tile that fits is resident');
  assert.deepEqual(errors, []);
});

test('a tile left out while its bytes are on their way is not claimed when they land', async () => {
  const file = cooked([{ kind: 'mesh', tiles: [tile()] }], [place(0)]);
  const { tiles, bodies, fetched } = await streamedModel(file, new Uint8Array(1));
  tiles.update([0, 0, 0], 10);
  tiles.update([100, 0, 0], 10);
  await landed();
  assert.deepEqual([fetched.length, bodies.count.collisionBytes], [2, 0], 'asked, then left out');
});

test('a physics budget that does not exist, as the removed triangles, is refused by name', () => {
  const runtime = { invalidate() {}, explorer: null },
    camera = () => new Camera('perspective');
  const budget = { triangles: 5_000_000 } as never;
  assert.throws(() => createWorldPhysics(runtime, new Group(), camera, { budget }), {
    code: 'PHYSICS_BUDGET',
    message: /"triangles"/,
  });
  const physics = createWorldPhysics(runtime, new Group(), camera, true);
  assert.throws(() => Object.assign(physics.budget, { triangles: 1 }), /triangles/);
  physics.dispose();
});
