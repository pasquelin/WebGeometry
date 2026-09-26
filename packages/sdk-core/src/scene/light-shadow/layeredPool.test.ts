// #818: at 3 456 × 2 234 one sun reads 2 520 pages a frame, and the pool holds two such reports, in
// two layers: the list names every page it holds, and two reports that alternate evict nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneLightStore } from '../light/store.ts';
import { createShadowPlan } from './plan.ts';
import { SUN, cycle, sunPages } from './lightShadow.fixture.ts';
import { shadowPoolPages, shadowPoolShape } from './virtual.ts';

/** The owner's pool, a sun planned over it, and the 50 × 50 pages of `step` levels above its
 *  finest around the camera: 2 500 a level, under half the pool. */
function sunOverPool() {
  const { side, layers } = shadowPoolShape(shadowPoolPages(3456, 2234)),
    store = createSceneLightStore(),
    plan = createShadowPlan(side, layers);
  store.add(SUN);
  cycle(plan, store, 0, () => []);
  const slice = store.sliceOf(0),
    around = Array.from({ length: 2500 }, (_, i) => [(i % 50) - 25, Math.floor(i / 50) - 25]);
  const level = (step: number) => sunPages(plan, slice, plan.sun.finest[slice] + step, around);
  return { store, plan, level };
}

test('a report that names as many pages as the pool holds is listed whole', () => {
  const { store, plan, level } = sunOverPool();
  const read = [...level(5), ...level(6)];
  assert.ok(read.length > 4096 && read.length <= plan.pool.pages, `${read.length} pages`);
  for (let frame = 1; frame < 3; frame++) cycle(plan, store, frame, () => read);
  assert.equal(plan.requests.counts.requested, read.length);
  assert.equal(plan.requests.counts.unlisted, 0);
});

test('two reports of under half the pool, alternating, evict nothing either reads again', () => {
  const { store, plan, level } = sunOverPool();
  const reads = [level(5), level(6)];
  for (let frame = 1; frame < 12; frame++) cycle(plan, store, frame, () => reads[frame % 2]);
  assert.ok(plan.pool.used() > 5000, `both reports held: ${plan.pool.used()} pages`);
  assert.equal(plan.pool.refetched, 0);
});
