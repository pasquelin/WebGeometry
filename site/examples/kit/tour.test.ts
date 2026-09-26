import assert from 'node:assert/strict';
import test from 'node:test';
import { tour, type Pose } from './tour.ts';

const point = () => ({
  x: 0,
  y: 0,
  z: 0,
  set(x: number, y: number, z: number) {
    Object.assign(this, { x, y, z });
  },
});

/** A world whose frames and canvas press the test fires by hand. */
function fakeWorld() {
  const hooks: ((frame: { delta: number }) => void)[] = [];
  let press = () => {};
  const world = {
    canvas: {
      addEventListener: (type: string, listener: () => void) => void (press = listener),
      removeEventListener: () => {},
    },
    onFrame: (hook: (frame: { delta: number }) => void) => (hooks.push(hook), () => {}),
    invalidate: () => {},
    camera: { position: point() },
    controls: { update: () => {}, target: point() },
  };
  return {
    world,
    frame: () => hooks.forEach((hook) => hook({ delta: 0.05 })),
    press: () => press(),
  };
}

const POSES: Pose[] = [
  { name: 'close', position: [2, 0, 0], target: [0, 0, 1], seconds: 1, hold: 0.5 },
  { name: 'far', position: [20, 0, 0], target: [0, 0, 2], seconds: 1, hold: 0.5 },
  { name: 'pan', position: [20, 0, 0], target: [9, 0, 2], seconds: 0.25, hold: 0.1 },
  { name: 'still', position: [20, 0, 0], target: [9, 0, 2], seconds: 0.05, hold: 1 },
];

test('a tour reaches every pose in order at its time, then ends', () => {
  const fake = fakeWorld();
  const flown = tour(fake.world as never, POSES);
  const seen: unknown[][] = [],
    [{ position }, { target }] = [fake.world.camera, fake.world.controls];
  for (let frame = 1; frame <= 90; frame++) {
    fake.frame();
    seen.push([flown.part, +position.x.toFixed(2), +target.x.toFixed(2)]);
  }
  // At 50 ms a frame: the close-up lands at 1 s (frame 20), the far view at 2.5 s (frame 50),
  // the pan at 3.25 s (frame 65), and the still hold ends at 4.4 s (frame 88).
  assert.deepEqual(seen[19], ['close', 2, 0]);
  assert.deepEqual(seen[49], ['far', 20, 0]);
  assert.deepEqual(seen[64], ['pan', 20, 9]);
  assert.deepEqual(seen[70], ['still', 20, 9]);
  assert.deepEqual(seen[89], [null, 20, 9]);
  const order = seen.map(([part]) => part).filter((part, k, all) => part !== all[k - 1]);
  assert.deepEqual(order, ['close', 'far', 'pan', 'still', null]);
  assert.equal(flown.gliding, false);
});

test("the viewer's press ends the tour where it is", () => {
  const fake = fakeWorld();
  const flown = tour(fake.world as never, POSES);
  fake.frame();
  fake.press();
  const { x } = fake.world.camera.position;
  fake.frame();
  assert.equal(flown.part, null);
  assert.equal(fake.world.camera.position.x, x);
});
