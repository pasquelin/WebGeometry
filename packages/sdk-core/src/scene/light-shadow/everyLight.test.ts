// No shadow is dropped for want of page table: every shadow-casting light up to the slices
// holds a slice and its own range, even when every one of them is a sun, the largest range; a
// caster past them still lights, without a shadow, and the frame counts it (#822).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SHADOW_SLICES } from '../light/contracts.ts';
import { createSceneLightStore } from '../light/store.ts';
import { createShadowPlan } from './plan.ts';
import { SUN_ENTRIES } from './virtual.ts';
import { SUN, planFrame } from './lightShadow.fixture.ts';

test('every shadow-casting light up to MAX_SHADOW_SLICES holds a slice and a table range, suns included', () => {
  const store = createSceneLightStore();
  const plan = createShadowPlan(32);
  for (let i = 0; i < MAX_SHADOW_SLICES; i++) store.add({ ...SUN, id: `sun${i}` });
  planFrame(plan, store, 0);
  const bases = new Set<number>();
  for (let slot = 0; slot < store.count; slot++) {
    const slice = store.sliceOf(slot);
    assert.ok(slice >= 0, `light ${slot} has a slice`);
    const base = plan.table.baseOf(slice);
    assert.ok(base >= 0 && base + SUN_ENTRIES <= plan.table.entries, `light ${slot} has a range`);
    bases.add(base);
  }
  assert.equal(bases.size, MAX_SHADOW_SLICES, 'no two lights share a range');
});

test('a shadow caster past the slices is kept, unshadowed, and counted', () => {
  const store = createSceneLightStore();
  const plan = createShadowPlan(32);
  for (let i = 0; i < MAX_SHADOW_SLICES + 3; i++) store.add({ ...SUN, id: `sun${i}` });
  planFrame(plan, store, 0);
  assert.equal(store.count, MAX_SHADOW_SLICES + 3, 'no light refused');
  assert.equal(plan.counts.unslicedCasters, 3);
  for (let slot = MAX_SHADOW_SLICES; slot < store.count; slot++)
    assert.equal(store.sliceOf(slot), -1, `light ${slot} holds no slice`);
});
