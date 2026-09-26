// Issue #25: 8 lights + sun, two identical runs. The pose barrier drains the shadow pages until a
// report proves the image reads only drawn pages; a tile that invalidates every page, like
// `shadowsFollowTextures`, once left pages pending and made the A/A witness diverge (0 / 1,392 /
// 6,278 px). Every frame now draws every page it marks (#489): nothing is left pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneLightStore } from '../light/store.ts';
import { createShadowPlan } from './plan.ts';
import type { SceneLight } from '../light/contracts.ts';
import { SUN, cycle, lampPages, planFrame, report, sunPages } from './lightShadow.fixture.ts';
import { PAGE_MAPPED, shadowRequestCap } from './virtual.ts';

const EVERYWHERE_MIN = [-1e30, -1e30, -1e30],
  EVERYWHERE_MAX = [1e30, 1e30, 1e30];
/** Frames the barrier spends at most draining (`SHADOW_DRAIN_LIMIT`). */
const DRAIN = 64;

function pointLight(id: string, castsShadow: boolean): SceneLight {
  return {
    id,
    kind: 'point',
    position: [0, 2, -4],
    color: [1, 1, 1],
    intensity: 1,
    range: 8,
    castsShadow,
  };
}

function scene(points: number, sun: boolean, shadows: boolean) {
  const store = createSceneLightStore();
  const plan = createShadowPlan(32);
  if (sun) store.add({ ...SUN, castsShadow: shadows });
  for (let i = 0; i < points; i++) store.add(pointLight(`l${i}`, shadows));
  planFrame(plan, store, 0);
  // What the shading reads: the coarsest mip of every lamp face, and one page of the sun.
  const read = () => {
    const entries: number[] = [];
    for (let slot = 0; slot < store.count; slot++) {
      const slice = store.sliceOf(slot);
      if (slice < 0) continue;
      if (store.light(store.ids[slot])?.kind === 'directional')
        entries.push(...sunPages(plan, slice, plan.sun.finest[slice] + 6, [[0, 0]]));
      else for (let face = 0; face < 6; face++) entries.push(...lampPages(plan, slice, face, 5));
    }
    return entries;
  };
  return { store, plan, read };
}

/** Frames until nothing waits, invalidating everything every `every` frames; null past the limit. */
function drain({ store, plan, read }: ReturnType<typeof scene>, every: number) {
  for (let frame = 1; frame < DRAIN; frame++) {
    if (every > 0 && frame > 2 && frame % every === 0)
      plan.worldChanged(EVERYWHERE_MIN, EVERYWHERE_MAX);
    cycle(plan, store, frame, read);
    if (frame > 1 && plan.counts.pendingPages === 0 && plan.settled(store)) return frame;
  }
  return null;
}

test('no lights: the shadow queue stays empty', () => {
  const { plan } = scene(0, false, true);
  assert.equal(plan.counts.pendingPages, 0);
});

test('sun only: the pages drain', () => {
  assert.notEqual(drain(scene(0, true, true), 0), null);
});

test('8 lights with shadows off: nothing to drain', () => {
  const setup = scene(8, true, false);
  assert.equal(setup.plan.pool.used(), 0);
  assert.equal(setup.plan.counts.pendingPages, 0);
});

test('8 lights + sun and a tile that invalidates everything: every frame leaves nothing pending', () => {
  const setup = scene(8, true, true);
  const { store, plan, read } = setup;
  for (let frame = 1; frame < 24; frame++) {
    if (frame > 2 && frame % 8 === 0) plan.worldChanged(EVERYWHERE_MIN, EVERYWHERE_MAX);
    cycle(plan, store, frame, read);
    assert.equal(plan.counts.pendingPages, 0, `frame ${frame}`);
  }
  assert.ok(plan.settled(store), 'a report proves the image reads only drawn pages');
});

/** A point light over a pool of 4 × 4 pages, planned once; `face` at mip 2 is 64 pages. */
function smallPool() {
  const store = createSceneLightStore();
  const plan = createShadowPlan(4);
  store.add(pointLight('lamp', true));
  planFrame(plan, store, 0);
  return { store, plan, fine: lampPages(plan, store.sliceOf(0), 0, 2) };
}

test('a read set larger than the pool maps what fits, then holds: the rest waits for nothing', () => {
  const { store, plan, fine } = smallPool();
  let frame = 1;
  for (; frame < DRAIN && !(plan.counts.pendingPages === 0 && plan.settled(store)); frame++)
    cycle(plan, store, frame, () => fine);
  assert.ok(frame < DRAIN, 'the image holds');
  assert.equal(plan.pool.used(), 16);
  assert.equal(
    plan.requests.counts.refused,
    fine.length - 15,
    'and publishes what it could not map, the floor under them mapped first',
  );
});

test('a report past its list holds only once the pages it listed fill the pool', () => {
  const { store, plan, fine } = smallPool();
  // One page read, then entries of no light up to the list's end, and more past it.
  const filler = Array.from(
    { length: shadowRequestCap(plan.pool.pages) - 1 },
    (_, i) => (1 << 19) + i,
  );
  const truncated = (frame: number, listed: number[]) =>
    plan.receive({
      frame,
      layoutEpoch: plan.table.layoutEpoch,
      stamp: plan.stamp(store),
      count: shadowRequestCap(plan.pool.pages) + 100,
      entries: Uint32Array.from([...listed, ...filler].slice(0, shadowRequestCap(plan.pool.pages))),
    });
  for (let frame = 1; frame < 4; frame++) {
    truncated(frame, fine.slice(0, 1));
    planFrame(plan, store, frame + 1);
    plan.commit();
  }
  assert.equal(plan.settled(store), false, 'the pool has room for what the list left out');
  for (let frame = 4; frame < 8; frame++) {
    truncated(frame, fine.slice(0, 16));
    planFrame(plan, store, frame + 1);
    plan.commit();
  }
  assert.equal(plan.settled(store), true, 'the listed pages fill the pool: nothing more fits');
});

// The GPU appends a report's entries in its atomic order: which pages a full pool maps must not
// follow it, or two captures of one pose hold different shadows.
test('which pages a full pool maps does not depend on the order the report lists them in', () => {
  const mapped = (order: (entries: number[]) => number[]) => {
    const { store, plan, fine } = smallPool();
    report(plan, store, 1, order(fine));
    planFrame(plan, store, 2);
    return fine.filter((entry) => plan.table.words[entry] & PAGE_MAPPED);
  };
  const forward = mapped((entries) => entries);
  assert.equal(forward.length, 15, 'the pool less the floor under them');
  assert.deepEqual(
    mapped((entries) => entries.slice().reverse()),
    forward,
  );
});
