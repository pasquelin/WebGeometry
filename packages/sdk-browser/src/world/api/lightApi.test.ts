// The public light API hands out detached copies and keeps none of the host's arrays. Before
// this batch, `lights()` spread the held record: its `position`, `color` and `direction` were
// the store's own arrays, and a host writing into what it had just read changed the engine's
// record without the buffer, the revision or the epoch knowing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_FIELD,
  SCENE_LIGHT_HEADER_FLOATS,
  createSceneLightStore,
  type SceneLight,
} from '../../../../sdk-core/src/index.ts';
import { createExplorerLightApi } from './lightApi.ts';
import type { RenderBackend } from '../../backend/types.ts';

const LAMP: SceneLight = {
  id: 'l0',
  kind: 'spot',
  position: [1, 2, 3],
  direction: [0, -1, 0],
  color: [1, 0.5, 0.25],
  intensity: 4,
  range: 10,
  coneAngle: 0.5,
  castsShadow: true,
};

function session(imported: readonly string[] = []) {
  const store = createSceneLightStore();
  const api = createExplorerLightApi({
    check: () => {},
    store,
    imported,
    backends: [],
    active: () => ({ id: 'none' }) as unknown as RenderBackend,
  });
  return { store, api };
}
/** The engine's view of a light: its held record and its floats in the packed buffer. */
const engineView = (store: ReturnType<typeof createSceneLightStore>, id: string) => ({
  record: structuredClone(store.light(id)),
  packed: store.packed.slice(),
});

test('a host that mutates a light after submitting it changes nothing in the engine', () => {
  const { store, api } = session();
  const submitted: SceneLight = structuredClone(LAMP);
  api.addLight(submitted);
  const before = engineView(store, 'l0');
  submitted.position![0] = 99;
  submitted.color[1] = 99;
  submitted.direction![2] = 99;
  submitted.intensity = 99;
  assert.deepEqual(engineView(store, 'l0'), before, 'add copied on the way in');
  const patch = { position: [7, 8, 9] as [number, number, number] };
  api.setLight('l0', patch);
  const after = engineView(store, 'l0');
  patch.position[0] = 99;
  assert.deepEqual(engineView(store, 'l0'), after, 'set copied on the way in too');
  assert.equal(after.packed[SCENE_LIGHT_HEADER_FLOATS + LIGHT_FIELD.position], 7, 'buffer written');
});

test('a light read back never aliases the store: writing into it changes nothing', () => {
  const { store, api } = session();
  api.addLight(structuredClone(LAMP));
  const epoch = store.epoch;
  const before = engineView(store, 'l0');
  const [read] = api.lights();
  assert.notEqual(read, store.light('l0'), 'a copy, not the record');
  for (const field of ['position', 'color', 'direction'] as const)
    assert.notEqual(read[field], store.light('l0')![field], `${field} is a new array`);
  read.position![0] = 99;
  read.color[1] = 99;
  read.direction![2] = 99;
  read.intensity = 99;
  assert.deepEqual(engineView(store, 'l0'), before, 'the engine still holds the validated light');
  assert.equal(store.epoch, epoch, 'and no change was published');
  assert.deepEqual(api.lights()[0], before.record, 'the next read is clean');
});

test('imported lights are the same detached copies', () => {
  const { store, api } = session(['l0']);
  store.add(structuredClone(LAMP));
  const [read] = api.importedLights();
  assert.notEqual(read.position, store.light('l0')!.position);
  read.position![1] = 99;
  assert.equal(store.light('l0')!.position![1], 2);
  assert.equal(api.importedLights()[0].position![1], 2);
});

test('the environment read back is a copy of the held exposure', () => {
  const { store, api } = session();
  api.setEnvironment({ exposure: 1.5 });
  const read = api.environment!;
  assert.notEqual(read, store.environment);
  read.exposure = 99;
  assert.equal(store.environment!.exposure, 1.5);
});
