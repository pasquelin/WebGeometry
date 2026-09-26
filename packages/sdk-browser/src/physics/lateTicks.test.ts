import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ASLEEP_BIT,
  CommandWriter,
  DEFAULT_PHYSICS_BUDGET,
  MAX_CATCH_UP_STEPS,
  ObjectPhysics,
  PHYSICS_STEP,
  POSE_WORDS,
} from '../../../sdk-core/src/physics/index.ts';
import { composeMatrix4 } from '../../../sdk-core/src/math/matrix/matrix4Compose.ts';
import { box } from '../../../sdk-core/src/world/geometry/basic.ts';
import { Mesh } from '../../../sdk-core/src/world/object/mesh.ts';
import { Group } from '../../../sdk-core/src/world/object/object3d.ts';
import type { Bodied } from './bodies.ts';
import { body, startModule } from './module.fixture.ts';
import { createPhysicsPoses } from './poses.ts';
import { PHYSICS_PROTOCOL, resultWords, type FromPhysics, type ToPhysics } from './protocol.ts';

/** `count` seated crates in slots 0.., their rows in one batch, and the frames' `placed` calls. */
function seated(count: number) {
  const scene = new Group();
  const batch = { rows: { matrices: new Float64Array(16 * count) } };
  const placed: number[] = [];
  scene._link = {
    ...{ pose() {}, posed() {}, structure() {}, content() {}, seatEpoch: () => 0 },
    seat: (node) => ({ batch, row: meshes.indexOf(node as Bodied) }),
    placed: (_, from, to) => placed.push(to - from + 1),
  };
  const meshes = Array.from({ length: count }, () => {
    const crate = new Mesh(box()) as Bodied;
    crate.physics = new ObjectPhysics('dynamic');
    crate._link = scene._link;
    scene.add(crate);
    return crate;
  });
  const bodies = { meshes, generation: new Uint8Array(count), retire() {} };
  return { scene, batch, placed, meshes, bodies };
}

/** A tick's records: slot `i` at height `y + i`, turning, moving at `v` m/s up (asleep: `sleep`). */
function records(count: number, y: number, v: number, sleep = false) {
  const words = new Uint32Array(count * POSE_WORDS),
    floats = new Float32Array(words.buffer);
  for (let i = 0; i < count; i++) {
    words[i * POSE_WORDS] = i | (sleep ? ASLEEP_BIT : 0);
    floats.set(
      [i, y + i, 0, 0, Math.sin(y / 4), 0, Math.cos(y / 4), 0, v, 0, 0, 0.5, 0],
      i * POSE_WORDS + 1,
    );
  }
  return words;
}

test("a worker late by slow steps changes none of the page's frames: each draws every body once", (t) => {
  // The same frames, 8 ms apart, against a worker at one step a tick and one at four steps a
  // tick, each step 25 ms long: the page draws on, a late tick interpolated then extrapolated.
  for (const [steps, every] of [
    [1, PHYSICS_STEP * 1000],
    [MAX_CATCH_UP_STEPS, MAX_CATCH_UP_STEPS * 25],
  ]) {
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    const { scene, placed, bodies } = seated(3);
    const poses = createPhysicsPoses(3, scene);
    for (let frame = 0, next = 0, y = 0; frame < 60; frame++, clock += 8) {
      if (clock >= next) {
        poses.receive(records(3, (y += steps), 1), 3, bodies, steps * PHYSICS_STEP * 1000);
        next += every;
      }
      placed.length = 0;
      assert.equal(poses.apply(bodies), true, `frame ${frame} asks for the next`);
      assert.deepEqual(placed, [3], `frame ${frame} writes the three rows once`);
    }
  }
});

test('every row drawn is its body pose composed: short of the target, on it and past it', (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const { scene, batch, meshes, bodies } = seated(3);
  const poses = createPhysicsPoses(3, scene);
  const expect = (label: string) =>
    meshes.forEach((mesh, row) => {
      const composed = composeMatrix4(
        new Float64Array(16),
        mesh.position.elements,
        mesh.quaternion.elements,
        mesh.scale.elements,
      );
      assert.deepEqual(batch.rows.matrices.subarray(row * 16, row * 16 + 16), composed, label);
      mesh.updateWorldMatrix(true, false);
      assert.deepEqual(mesh.matrixWorld.elements, composed, `${label}: the tree holds it`);
      assert.ok(Math.abs(Math.hypot(...mesh.quaternion.elements) - 1) < 1e-6, `${label}: a turn`);
    });
  poses.receive(records(3, 1, 0), 3, bodies, 16);
  clock = 16;
  poses.apply(bodies);
  poses.receive(records(3, 2, 3), 3, bodies, 16);
  clock += 8;
  poses.apply(bodies);
  expect('short of the target');
  assert.ok(meshes[0].position.y > 1 && meshes[0].position.y < 2);
  clock += 20;
  poses.apply(bodies);
  expect('past it, moved on by its velocity');
  assert.ok(meshes[0].position.y > 2);
  poses.receive(records(3, 4, 0, true), 3, bodies, 16);
  clock += 40;
  poses.apply(bodies);
  expect('on it, asleep');
  assert.equal(meshes[2].position.y, 6);
});

test('slow steps never cost the worker a step: the ceiling a tick, each one fixed, in order', async () => {
  // The worker's clock: a step reads it before and after, and each step is 25 ms long.
  let now = 0,
    reads = 0;
  const clock = () => {
    const read = now;
    if (reads++ % 2 === 1) now += 25;
    return read;
  };
  Object.defineProperty(performance, 'now', { value: clock, configurable: true });
  const scope = globalThis as unknown as Record<string, unknown>;
  const bytes = await readFile(new URL('./joltPhysics.wasm', import.meta.url));
  scope.fetch = async () => new Response(bytes);
  scope.location = { href: import.meta.url };
  const ticks: [() => void, number][] = [];
  const sent: FromPhysics[] = [];
  let onReady = () => {};
  const ready = new Promise<void>((resolve) => (onReady = resolve));
  scope.postMessage = (message: FromPhysics) => {
    if (message.type === 'results') sent.push({ ...message, buffer: message.buffer.slice(0) });
    if (message.type === 'ready') {
      scope.setTimeout = (tick: () => void, ms: number) => ticks.push([tick, ms]);
      onReady();
    }
  };
  await import('./physicsWorker.ts');
  const receive = (data: ToPhysics) =>
    (scope.onmessage as (event: { data: ToPhysics }) => void)({ data });
  const budget = { ...DEFAULT_PHYSICS_BUDGET, bodies: 8, memoryBytes: 64 << 20 };
  const buffers = [0, 1].map(() => new ArrayBuffer(resultWords(budget) * 4));
  receive({ type: 'start', protocol: PHYSICS_PROTOCOL, wasm: 'x', budget, threads: 1, buffers });
  await ready;
  ticks.shift()![0]();
  const writer = new CommandWriter();
  writer.gravity([0, -9.81, 0]);
  writer.add(body(0, 2, 10, 0.5));
  const words = writer.take();
  reads = 0;
  receive({ type: 'commands', words: words.slice() });
  let taken = 0;
  while (taken < 40) {
    const [tick, ms] = ticks.shift()!;
    now += ms;
    reads = 0;
    tick();
    const results = sent.filter((m) => m.type === 'results').slice(-1)[0];
    taken += results.steps;
    receive({ type: 'buffer', buffer: new ArrayBuffer(resultWords(budget) * 4) });
  }
  const results = sent.filter((m) => m.type === 'results');
  for (const tick of results) {
    assert.ok(tick.steps >= 1 && tick.steps <= MAX_CATCH_UP_STEPS, `${tick.steps} steps a tick`);
    assert.equal(tick.seconds, tick.steps * PHYSICS_STEP, 'fixed steps, never stretched');
    assert.equal(tick.poses, 1, "one record a body, whatever the tick's steps");
  }
  assert.ok(
    results.some((tick) => tick.steps === MAX_CATCH_UP_STEPS),
    'the ceiling holds',
  );
  assert.ok(taken * PHYSICS_STEP * 1000 < now, 'the simulation lags real time, never skips');
  // The same steps, one after the other, straight on the module: the same body, to the bit.
  const jolt = await startModule({ bodies: 8 });
  jolt.step(words, PHYSICS_STEP);
  for (let step = 1; step < taken; step++) jolt.step(null, PHYSICS_STEP);
  const last = new Uint32Array(results.at(-1)!.buffer, 0, POSE_WORDS);
  assert.deepEqual(last, jolt.poses(1).slice(0, POSE_WORDS));
});
