import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PHYSICS_BUDGET,
  GENERATION_SHIFT,
  type CookedSoftBody,
} from '../../../sdk-core/src/physics/index.ts';
import { Camera } from '../../../sdk-core/src/world/camera/camera.ts';
import { Group } from '../../../sdk-core/src/world/object/object3d.ts';
import { createPhysicsSession } from './session.ts';
import {
  compiledModel,
  cooked,
  landed,
  place,
  streamedModel,
  stubFetch,
  tile,
} from './tiles.fixture.ts';
import { fakeWorkers, idleTick } from './worker.fixture.ts';

/** A `physics.json` of one two-triangle tile at the origin, placed once, and `softBodies`. */
const oneTile = (softBodies: CookedSoftBody[] = []) =>
  cooked([{ kind: 'mesh', tiles: [tile()] }], [place(0)], softBodies);

/** Holds every fetch from now on; `answer(name)` lets the first one waiting for `name` through,
 *  if any, and waits for what it lands. */
function heldFetches() {
  const fetchNow = globalThis.fetch,
    waiting: [string, () => void][] = [];
  globalThis.fetch = ((url: string) =>
    new Promise((go) => waiting.push([url, () => go(fetchNow(url))]))) as typeof fetch;
  return async (name: string) => {
    const at = waiting.findIndex(([url]) => url.endsWith(name));
    if (at >= 0) waiting.splice(at, 1)[0][1]();
    await landed();
  };
}

test('a model back while its physics.json or a tile is on its way holds one set of tile bodies', async () => {
  const { tiles, scene, model, bodies } = await streamedModel(oneTile(), new Uint8Array(1));
  const answer = heldFetches();
  const near = () => tiles.update([0, 0, 0], 1000);
  const back = () => {
    scene.remove(model);
    tiles.scan(scene);
    scene.add(model);
    tiles.scan(scene);
  };
  const held = () => [bodies.count.bodies, bodies.count.collisionBytes];
  // Two openings on their way; the earlier lands first, and its tile would load before the later.
  back();
  back();
  await answer('physics.json');
  near();
  await answer('t0.bin');
  await answer('physics.json');
  near();
  await answer('t0.bin');
  assert.deepEqual(held(), [1, 2], 'the later opening’s tile alone');
  // A tile on its way while its model leaves and comes back, landing after the new opening.
  back();
  await answer('physics.json');
  near();
  back();
  await answer('physics.json');
  await answer('t0.bin');
  near();
  await answer('t0.bin');
  assert.deepEqual(held(), [1, 2], 'the new opening’s tile alone');
});

test('a cooked soft body and a tile the worker refuses give their slots and budget back', async () => {
  const { workers, restore } = fakeWorkers();
  try {
    const cloth: CookedSoftBody = {
      ...{ node: 1, position: [0, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      ...{ physics: { type: 'cloth', pins: [0] }, vertices: 9, pressure: 0 },
      ...{
        friction: 0.5,
        restitution: 0,
        settings: { url: 'cloth.bin', sha256: 'c'.repeat(64), bytes: 1 },
      },
    };
    const fetched = stubFetch(oneTile([cloth]), new Uint8Array(1));
    const [scene, model] = [new Group(), compiledModel()];
    scene.add(model);
    const wanted = { joints: new Set<never>(), vehicles: new Set<never>() };
    const session = createPhysicsSession(
      scene,
      DEFAULT_PHYSICS_BUDGET,
      () => {},
      () => {},
      wanted,
    );
    const [worker] = workers;
    worker.onmessage({ data: { type: 'ready' } });
    const camera = new Camera('perspective');
    session.frame(camera);
    await landed(); // opened: its cloth made in the first slot
    session.frame(camera);
    await landed(); // its tile loaded in the second
    const [soft, ground] = [0, 1].map((index) => index | (1 << GENERATION_SHIFT));
    assert.deepEqual([session.objectOf(soft), session.objectOf(ground)], [model, model]);
    const refusal = { type: 'error', code: 'PHYSICS_FAILED', message: '', fatal: false };
    worker.onmessage({ data: { ...refusal, bodies: [soft, ground] } });
    worker.onmessage({ data: idleTick });
    assert.equal(session.stats.bodies, 0, 'both slots given back, their budget with them');
    assert.deepEqual([session.objectOf(soft), session.objectOf(ground)], [null, null]);
    // Its model moved: nothing refused is carried, nor made again.
    const carried: number[] = [];
    const { writer } = session;
    const [teleport, flags] = [writer.teleport.bind(writer), writer.flags.bind(writer)];
    writer.teleport = (slot, ...rest) => (carried.push(slot), teleport(slot, ...rest));
    writer.flags = (slot, ...rest) => (carried.push(slot), flags(slot, ...rest));
    model.position.set(1, 0, 0);
    model.updateMatrixWorld(true);
    session.pose(model);
    session.frame(camera);
    await landed();
    worker.onmessage({ data: idleTick });
    assert.deepEqual(carried, [], 'neither carried');
    assert.equal(session.stats.bodies, 0, 'nor made again');
    assert.deepEqual(fetched.sort(), ['cloth.bin', 'physics.json', 't0.bin']);
    session.dispose();
  } finally {
    restore();
  }
});
