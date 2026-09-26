// #811: drive-a-car's car, motorcycle and tank, each body and wheel its own box, under a sun and
// the chase camera at 960 × 600, stale exactly the pages their boxes overlap, as each alone would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneLightStore } from '../light/store.ts';
import { createShadowPlan } from './plan.ts';
import { shadowPoolSide } from './virtual.ts';
import { SUN, VIEW, cycle, planFrame, sunPages } from './lightShadow.fixture.ts';

/** The example's chase camera, 7.5 m behind the car and 2.4 m up, at 960 × 600. */
const CHASE = { ...VIEW, position: [0, 2.4, 7.5] as const, pixelNear: VIEW.pixelNear * 1.2 };
const grid = (xs: number[], zs: number[]) => xs.flatMap((x) => zs.map((z) => [x, z]));
/** A vehicle's body box, then a box per wheel, each over where it was and is, 20 cm apart. */
const vehicle = (x: number, [w, h, d]: number[], wheels: number[][], r: number) =>
  [[x - w / 2, 0, -d / 2, x + w / 2, h, d / 2]]
    .concat(wheels.map(([u, z]) => [x + u - 0.15, 0, z - r, x + u + 0.15, 2 * r, z + r]))
    .map(([x0, y0, z0, x1, y1, z1]) => ({ min: [x0, y0, z0 - 0.2], max: [x1, y1, z1] }));
const car = vehicle(0, [1.9, 1.3, 4.6], grid([-0.8, 0.8], [-1.35, 1.35]), 0.33),
  bike = vehicle(-6, [0.5, 1.2, 2], grid([0], [-0.72, 0.72]), 0.31),
  tank = vehicle(9, [3.7, 2.9, 8], grid([-1.55, 1.55], [-3, -1.8, -0.6, 0.6, 1.8, 3]), 0.42);
/** Settling side by side: the bodies are written first, then the wheels. */
const ROOTS = [tank[0], car[0], bike[0], ...tank.slice(1), ...bike.slice(1), ...car.slice(1)];

/** The example's sun, every page the chase view reads around the car drawn: finer near it. */
function settled() {
  const store = createSceneLightStore(),
    plan = createShadowPlan(shadowPoolSide(960, 600));
  const toward = [-40, -70, -25].map((a) => a / Math.hypot(40, 70, 25));
  store.add({ ...SUN, direction: toward as [number, number, number] });
  let read: number[] = [];
  cycle(plan, store, 0, () => read, CHASE);
  const slice = store.sliceOf(0),
    around = (n: number) =>
      grid([...Array(n).keys()], [...Array(n).keys()]).map(([x, y]) => [x - n / 2, y - n / 2]);
  read = [5, 6, 7, 8].flatMap((step, i) =>
    sunPages(plan, slice, plan.sun.finest[slice] + step, around([24, 16, 16, 8][i])),
  );
  for (let frame = 1; frame < 4; frame++) cycle(plan, store, frame, () => read, CHASE);
  return { store, plan };
}

/** Table entries of the stale pages. */
const stale = ({ pool }: ReturnType<typeof settled>['plan']) =>
  new Set([...pool.owner].filter((owner, page) => owner >= 0 && pool.dirty[page]));

test('a car stales exactly the pages its roots overlap, as when each root moves alone', () => {
  const own = new Set<number>();
  for (const root of ROOTS) {
    const { store, plan } = settled();
    assert.equal(stale(plan).size, 0, 'every page read is drawn');
    plan.worldChanged(root.min, root.max, true);
    planFrame(plan, store, 4, CHASE);
    for (const entry of stale(plan)) own.add(entry);
  }
  const { store, plan } = settled();
  for (const root of ROOTS) plan.worldChanged(root.min, root.max, true);
  planFrame(plan, store, 4, CHASE);
  assert.ok(own.size > 0);
  assert.deepEqual(stale(plan), own, 'the union of each root alone, and nothing more');
  assert.equal(plan.counts.invalidatedPages, own.size);
});
