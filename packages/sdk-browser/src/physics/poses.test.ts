import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASLEEP_BIT,
  CommandWriter,
  DEFAULT_PHYSICS_BUDGET,
  GENERATION_SHIFT,
  ObjectPhysics,
  type PhysicsHost,
} from '../../../sdk-core/src/physics/index.ts';
import { box } from '../../../sdk-core/src/world/geometry/basic.ts';
import { Material } from '../../../sdk-core/src/world/material/material.ts';
import { Mesh } from '../../../sdk-core/src/world/object/mesh.ts';
import { Group } from '../../../sdk-core/src/world/object/object3d.ts';
import { createPhysicsBodies, type Bodied } from './bodies.ts';
import { interpolateAll } from './drawnPoses.ts';
import { createPosePlacer } from './placer.ts';
import { createPhysicsPoses } from './poses.ts';
import { poseRecord } from './worker.fixture.ts';

/** One mesh in slot 0 at generation 0, as a tick's records name it. */
const lone = (mesh: Bodied) => ({ meshes: [mesh], generation: new Uint8Array(1), retire() {} });

test('a pose sent again unchanged moves nothing and asks for no frame', () => {
  const poses = createPhysicsPoses(4, new Group());
  const crate = new Mesh(box()) as Bodied;
  crate.physics = new ObjectPhysics('dynamic');
  const words = poseRecord(0, [0, 2, 0, 0, 0, 0, 1]);
  assert.equal(poses.receive(words, 1, lone(crate), 0), 1);
  assert.equal(poses.apply(lone(crate)), false);
  assert.equal(crate.position.y, 2);
  assert.equal(poses.receive(words, 1, lone(crate), 0), 0);
  assert.equal(poses.apply(lone(crate)), false);
});

test('a pose drawn by the batch leaves position, quaternion and angles coherent', () => {
  const poses = createPhysicsPoses(4, new Group());
  const crate = new Mesh(box()) as Bodied;
  crate.physics = new ObjectPhysics('dynamic');
  const half = Math.SQRT1_2;
  poses.receive(poseRecord(0, [1, 2, 3, 0, half, 0, half]), 1, lone(crate), 0);
  poses.apply(lone(crate));
  assert.deepEqual([crate.position.x, crate.position.y, crate.position.z], [1, 2, 3]);
  assert.ok(
    Math.abs(crate.rotation.y - Math.PI / 2) < 1e-3,
    `turned a quarter, ${crate.rotation.y}`,
  );
  crate.updateWorldMatrix(true, false);
  assert.ok(Math.abs(crate.matrixWorld.elements[13] - 2) < 1e-6, 'the tree holds the pose');
});

test('a seated body is drawn straight into its row, the world told the span once', () => {
  const scene = new Group();
  const crate = new Mesh(box()) as Bodied;
  crate.physics = new ObjectPhysics('dynamic');
  crate.scale.set(2, 2, 2);
  scene.add(crate);
  const batch = { rows: { matrices: new Float64Array(64) } };
  const told: unknown[] = [];
  scene._link = {
    pose() {},
    posed: (nodes) => told.push(['posed', nodes.length]),
    structure() {},
    content() {},
    seat: () => ({ batch, row: 2 }),
    seatEpoch: () => 0,
    placed: (at, from, to) => told.push([at === batch, from, to]),
  };
  crate._link = scene._link;
  const poses = createPhysicsPoses(4, scene);
  poses.receive(poseRecord(0, [1, 2, 3, 0, 0, 0, 1]), 1, lone(crate), 0);
  told.length = 0;
  poses.apply(lone(crate));
  assert.deepEqual(told, [[true, 2, 2]]);
  crate.updateWorldMatrix(true, false);
  assert.deepEqual(batch.rows.matrices.subarray(32, 48), crate.matrixWorld.elements);
});

test('a decorative body asleep is placed, taken out, and never added again', () => {
  const scene = new Group();
  const poses = createPhysicsPoses(4, scene);
  const budget = { ...DEFAULT_PHYSICS_BUDGET, bodies: 4 };
  const bodies = createPhysicsBodies(
    new CommandWriter(),
    budget,
    {} as PhysicsHost,
    scene,
    poses.state,
  );
  const mesh = new Mesh(box(), new Material('meshStandard'));
  mesh.physics = { decorative: true };
  const chip = mesh as Bodied;
  scene.add(chip);
  bodies.reconcile(new Set(), (error) => assert.fail(String(error)));
  const id = chip.physics._index | (bodies.generation[chip.physics._index] << GENERATION_SHIFT);
  poses.receive(poseRecord(id | ASLEEP_BIT, [0, 0.5, 0, 0, 0, 0, 1]), 1, bodies, 16);
  assert.equal(chip.position.y, 0.5);
  assert.equal(chip.physics.asleep, true, 'kept once out of the simulation');
  assert.equal(bodies.count.decorative, 0);
  bodies.reconcile(new Set(), (error) => assert.fail(String(error)));
  assert.equal(bodies.count.bodies, 0);
});

test('a record of a body that left its slot moves neither it nor the body in its place', () => {
  const scene = new Group();
  const poses = createPhysicsPoses(4, scene);
  const budget = { ...DEFAULT_PHYSICS_BUDGET, bodies: 4 };
  const bodies = createPhysicsBodies(
    new CommandWriter(),
    budget,
    {} as PhysicsHost,
    scene,
    poses.state,
  );
  const crate = new Mesh(box(), new Material('meshStandard')) as Bodied;
  crate.physics = new ObjectPhysics('dynamic');
  scene.add(crate);
  bodies.reconcile(new Set(), (error) => assert.fail(String(error)));
  const old = bodies.generation[0] << GENERATION_SHIFT;
  bodies.removeAt(0);
  const next = new Mesh(box(), new Material('meshStandard')) as Bodied;
  next.physics = new ObjectPhysics('dynamic');
  scene.add(next);
  bodies.add(next);
  assert.equal(next.physics._index, 0, 'the slot is taken again');
  assert.equal(poses.receive(poseRecord(old, [5, 5, 5, 0, 0, 0, 1]), 1, bodies, 0), 0);
  assert.deepEqual([crate.position.y, next.position.y], [0, 0]);
});

test('a turn is drawn the shorter way round, whichever sign its quaternion comes with', () => {
  const scene = new Group();
  const crate = new Mesh(box()) as Bodied;
  scene.add(crate);
  const placer = createPosePlacer(1, scene);
  placer.bind(0, 0, crate);
  placer.begin();
  placer.place(0, [0, 0, 0, 0, 0, 0, 1], 0);
  // A quarter turn about y, sent as its opposite quaternion: halfway is an eighth, not 3/8.
  const half = Math.SQRT1_2;
  const target = new Float32Array([0, 0, 0, 0, -half, 0, -half]);
  interpolateAll(new Int32Array([0]), 1, target, 0.5, placer.position, placer.quaternion);
  placer.commit(new Int32Array([0]), 1);
  placer.end();
  assert.ok(Math.abs(crate.rotation.y - Math.PI / 4) < 1e-3, `an eighth turn, ${crate.rotation.y}`);
});

test('a slot retired and taken again before a frame is drawn once, not twice', (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const scene = new Group();
  const poses = createPhysicsPoses(2, scene);
  const budget = { ...DEFAULT_PHYSICS_BUDGET, bodies: 2 };
  const bodies = createPhysicsBodies(
    new CommandWriter(),
    budget,
    {} as PhysicsHost,
    scene,
    poses.state,
  );
  const add = (mesh: Bodied) => {
    scene.add(mesh);
    bodies.reconcile(new Set(), (error) => assert.fail(String(error)));
    return mesh.physics._index | (bodies.generation[mesh.physics._index] << GENERATION_SHIFT);
  };
  const chip = new Mesh(box(), new Material('meshStandard')) as Bodied;
  chip.physics = new ObjectPhysics({ decorative: true });
  const id = add(chip);
  // Listed while it falls, then asleep and out before any frame drew it.
  poses.receive(poseRecord(id, [0, 1, 0, 0, 0, 0, 1]), 1, bodies, 16);
  clock += 16;
  poses.receive(poseRecord(id | ASLEEP_BIT, [0, 0.5, 0, 0, 0, 0, 1]), 1, bodies, 16);
  const crate = new Mesh(box(), new Material('meshStandard')) as Bodied;
  crate.physics = new ObjectPhysics('dynamic');
  const next = add(crate);
  assert.equal(crate.physics._index, 0, 'the slot is taken again');
  clock += 16;
  poses.receive(poseRecord(next, [0, 2, 0, 0, 0, 0, 1]), 1, bodies, 16);
  // Halfway through the tick: halfway to the target, from where it stood.
  clock += 8;
  poses.apply(bodies);
  assert.equal(crate.position.y, 1);
});
