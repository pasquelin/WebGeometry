// A mutation that resets already-held values is not a change. A host that returns its
// fixed lights every frame — the common case of a bench loop — must stale nothing: neither the
// light's revision, which the shadow scheduler reads to remake its pages, nor the store
// epoch, which the frame rereads to push its buffer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIGHT_FIELD, createSceneLightStore } from './store.ts';
import { SCENE_LIGHT_HEADER_FLOATS, type SceneLight } from './contracts.ts';
import { baseOf } from './fields.ts';

const LAMPE: SceneLight = {
  id: 'l0',
  kind: 'point',
  position: [1, 2, 3],
  color: [1, 0.5, 0.25],
  intensity: 4,
  range: 10,
  castsShadow: true,
};

test('a light reset identically raises neither its revision nor the epoch', () => {
  const store = createSceneLightStore();
  const slot = store.add({ ...LAMPE });
  const epoch = store.epoch,
    revision = store.revision[slot];
  // The arrays are new instances: value equality must decide.
  for (let i = 0; i < 10; i++)
    store.set('l0', { position: [1, 2, 3], color: [1, 0.5, 0.25], intensity: 4, range: 10 });
  assert.equal(store.epoch, epoch, 'ten identical mutations, no epoch published');
  assert.equal(store.revision[slot], revision, 'and no shadow page staled');
});

test('a single number that changes does publish the change', () => {
  const store = createSceneLightStore();
  const slot = store.add({ ...LAMPE });
  const epoch = store.epoch,
    revision = store.revision[slot];
  store.set('l0', { intensity: 4.5 });
  assert.equal(store.epoch, epoch + 1);
  assert.equal(store.revision[slot], revision + 1);
  assert.equal(store.light('l0')!.intensity, 4.5);
  // An array component counts as much as a simple field.
  store.set('l0', { position: [1, 2, 3.5] });
  assert.equal(store.epoch, epoch + 2);
  assert.deepEqual(store.light('l0')!.position, [1, 2, 3.5]);
});

test('turning off via the shadow flag remains a change', () => {
  const store = createSceneLightStore();
  store.add({ ...LAMPE });
  const epoch = store.epoch;
  store.set('l0', { castsShadow: false });
  assert.equal(store.epoch, epoch + 1);
  store.set('l0', { castsShadow: false });
  assert.equal(store.epoch, epoch + 1, 'reset twice, published once');
});

test('the environment follows the same rule as the lights', () => {
  const store = createSceneLightStore();
  store.setEnvironment({ exposure: 1.5 });
  const epoch = store.epoch;
  store.setEnvironment({ exposure: 1.5 });
  assert.equal(store.epoch, epoch, 'an exposure reset as-is does not stale the frame');
  store.setEnvironment({ exposure: 1.6 });
  assert.equal(store.epoch, epoch + 1);
  assert.equal(store.environment!.exposure, 1.6);
});

test('the lit view without a light is no longer an albedo view', () => {
  const store = createSceneLightStore();
  assert.equal(store.unlit, true, 'auto without a light: raw albedo, that is the default');
  store.setView('lit');
  assert.equal(store.unlit, false, 'lit asked explicitly: the contract lights, hence black');
  store.setView('unlit');
  assert.equal(store.unlit, true);
});

test('300 lights: every one is published, in the grown table the GPU reads (#822)', () => {
  const store = createSceneLightStore();
  const first = store.packed;
  for (let i = 0; i < 300; i++)
    store.add({ ...LAMPE, id: `l${i}`, position: [i, 0, 0], castsShadow: false });
  const header = new Uint32Array(store.packed.buffer, 0, SCENE_LIGHT_HEADER_FLOATS);
  assert.equal(store.count, 300);
  assert.ok(store.capacity >= 300);
  assert.equal(header[0], 300, 'count published');
  assert.notEqual(store.packed, first, 'the table grew');
  assert.ok(store.revision.length >= 300);
  for (let slot = 0; slot < 300; slot++)
    assert.equal(store.packed[baseOf(slot) + LIGHT_FIELD.position], slot, `light ${slot} written`);
  store.remove('l0');
  assert.equal(store.packed[baseOf(0) + LIGHT_FIELD.position], 299, 'the last took its slot');
});
