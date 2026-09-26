import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CommandWriter,
  EVENT_WORDS,
  PHYSICS_MATERIALS,
  PHYSICS_STEP,
  POSE_WORDS,
} from '../../../sdk-core/src/physics/index.ts';
import { gripOf } from '../../../sdk-core/src/collision/characterDrive.ts';
import {
  HUMAN_BODY,
  type CharacterInput,
} from '../../../sdk-core/src/collision/characterSettings.ts';
import { createCharacterDriver } from './characterDriver.ts';
import { body, standCharacter, startModule, type Module } from './module.fixture.ts';

const STILL: CharacterInput = { wishX: 0, wishZ: 0, sprint: false };
const EAST: CharacterInput = { wishX: 1, wishZ: 0, sprint: false };

/** A box body: its slot, motion, centre and half sizes, turned by `quaternion`. */
const block = (
  slot: number,
  motion: number,
  centre: number[],
  half: [number, number, number],
  quaternion = [0, 0, 0, 1],
) => ({ ...body(slot, motion, 0, 0), position: centre, size: half, quaternion });

/** A module with a floor of `friction` under y = 0 and `blocks`, and the human character
 *  standing at `feet`. */
async function world(blocks: ReturnType<typeof block>[], feet = [0, 0, 0], friction = 0.5) {
  const jolt = await startModule();
  const writer = new CommandWriter();
  writer.gravity([0, -9.81, 0]);
  writer.add({ ...block(0, 0, [0, -0.5, 0], [50, 0.5, 50]), friction });
  for (const b of blocks) writer.add(b);
  return { jolt, driver: standCharacter(jolt, writer.take(), feet) };
}

/** Steps as the worker does for `seconds`, the character driven by `input`; returns its feet. */
function live(
  { jolt, driver }: { jolt: Module; driver: ReturnType<typeof createCharacterDriver> },
  seconds: number,
  input: CharacterInput,
  each: (jolt: Module, t: number) => Uint32Array | null = () => null,
) {
  driver.press(input, 0);
  let top = -Infinity;
  const xs = new Map<number, number>();
  /** Each contact record of the run: `enter` or `leave` and the two engine ids. */
  const events: string[] = [];
  for (let t = 0; t < seconds; t += PHYSICS_STEP) {
    const move = driver.command(PHYSICS_STEP, jolt.active() > 0);
    const extra = each(jolt, t);
    const words = [extra, move].filter((w) => w !== null);
    const all = new Uint32Array(words.reduce((n, w) => n + w.length, 0));
    words.reduce((at, w) => (all.set(w, at), at + w.length), 0);
    const count = jolt.step(all, PHYSICS_STEP);
    const poses = jolt.poses(count),
      floats = new Float32Array(poses.buffer, poses.byteOffset, poses.length);
    for (let r = 0; r < count; r++)
      xs.set(poses[r * POSE_WORDS] & 0xffffff, floats[r * POSE_WORDS + 1]);
    const records = jolt.events();
    for (let at = 0; at < records.length; at += EVENT_WORDS)
      events.push(`${records[at] === 1 ? 'enter' : 'leave'} ${records[at + 1]} ${records[at + 2]}`);
    driver.read(jolt.character(), PHYSICS_STEP);
    top = Math.max(top, jolt.character()[2]);
  }
  const state = jolt.character();
  return { x: state[1], y: state[2], z: state[3], top, xs, events };
}

test('the Jolt character climbs a step up to its step height and is stopped by a higher one', async () => {
  const low = await world([block(1, 0, [7, 0.15, 0], [5, 0.15, 5])]);
  const onLow = live(low, 1.5, EAST);
  assert.ok(Math.abs(onLow.y - 0.3) < 0.02 && onLow.x > 1.6, `on the 0.3 m step: ${onLow.y}`);
  const high = await world([block(1, 0, [7, 0.4, 0], [5, 0.4, 5])]);
  const blocked = live(high, 1.5, EAST);
  assert.ok(blocked.y < 0.05 && blocked.x < 2, `before the 0.8 m wall: ${blocked.x}`);
});

test('the Jolt character walks up a slope below its steepest and not up one above', async () => {
  const ramp = (degrees: number) => {
    const half = (degrees * Math.PI) / 360;
    // A slab turned about z, rising toward +x, its top surface through the origin's height.
    return block(1, 0, [4, 0, 0], [3, 0.1, 5], [0, 0, Math.sin(half), Math.cos(half)]);
  };
  const gentle = live(await world([ramp(30)]), 2.5, EAST);
  assert.ok(gentle.y > 0.8, `up the 30° slope: ${gentle.y}`);
  const steep = live(await world([ramp(60)]), 2.5, EAST);
  assert.ok(steep.y < 0.5, `not up the 60° slope: ${steep.y}`);
});

test('the Jolt character rides a moving platform and jumps to the same apex', async () => {
  const deck = block(1, 1, [0, 0.1, 0], [2, 0.1, 2]);
  const scene = await world([deck], [0, 0.2, 0]);
  live(scene, 0.5, STILL);
  const writer = new CommandWriter();
  const ride = live(scene, 1, STILL, (_, t) => {
    writer.moveKinematic(1, [t + PHYSICS_STEP, 0.1, 0], [0, 0, 0, 1]);
    return writer.take();
  });
  assert.ok(Math.abs(ride.x - 1) < 0.1, `carried 1 m by the platform: ${ride.x}`);
  const ground = ride.y;
  scene.driver.press(STILL, 1);
  const { top } = live(scene, 1, STILL, (_, t) => {
    writer.moveKinematic(1, [1 + t + PHYSICS_STEP, 0.1, 0], [0, 0, 0, 1]);
    return writer.take();
  });
  const apex = HUMAN_BODY.jumpSpeed ** 2 / (2 * HUMAN_BODY.gravity);
  assert.ok(Math.abs(top - ground - apex) < 0.05, `apex ${top - ground} for ${apex}`);
});

test('the Jolt character glides to a stop over the friction of the floor it stands on', async () => {
  const v = HUMAN_BODY.walkSpeed;
  for (const { friction } of [PHYSICS_MATERIALS.stone, PHYSICS_MATERIALS.ice]) {
    const scene = await world([], [-45, 0, 0], friction);
    const from = live(scene, 3, EAST).x,
      glide = live(scene, 6, STILL).x - from,
      expected = (v * v) / (2 * gripOf(friction) * HUMAN_BODY.gravity);
    // One step of the page's input late, and the legs' last centimetre: within 3 cm.
    assert.ok(Math.abs(glide - expected) < 0.03 + v * PHYSICS_STEP, `${glide} m for ${expected} m`);
  }
});

test('the Jolt character pushes a crate lighter than its strength', async () => {
  // A 0.6 m cardboard box, too high to step onto: 32 kg, 160 N of friction under a 250 N push.
  const crate = { ...block(1, 2, [1.5, 0.3, 0], [0.3, 0.3, 0.3]), density: 150 };
  const { xs } = live(await world([crate]), 2, EAST);
  const x = xs.get(1) ?? 1.5;
  assert.ok(x > 2.5, `the crate was pushed to ${x}`);
});

test('a still character in a world at rest asks for no step: nothing is awake', async () => {
  const scene = await world([]);
  live(scene, 1, STILL);
  assert.equal(scene.jolt.active(), 0, 'its inner capsule does not count as awake');
  assert.equal(scene.driver.moving(), false);
});

test('a body thrown at the character twice hears enter and leave each time, named by it', async () => {
  // A weightless crate listening for contacts, bouncing off the capsule it is thrown at.
  const crate = { ...block(1, 2, [2, 0.9, 0], [0.2, 0.2, 0.2]), flags: 4 };
  const scene = await world([{ ...crate, restitution: 1, gravityScale: 0 }]);
  const writer = new CommandWriter();
  const thrown = (_: Module, t: number) =>
    t > 0 ? null : (writer.velocity(1, [-4, 0, 0]), writer.take());
  const seen = [
    ...live(scene, 1.5, STILL, thrown).events,
    ...live(scene, 1.5, STILL, thrown).events,
  ];
  assert.deepEqual(
    seen.map((e) => e.split(' ')[0]),
    ['enter', 'leave', 'enter', 'leave'],
    seen.join(', '),
  );
  // 64 page bodies: the character's inner capsule is engine id 64, the crate 1.
  assert.ok(
    seen.every((e) => e.endsWith(' 1 64') || e.endsWith(' 64 1')),
    seen.join(', '),
  );
});
