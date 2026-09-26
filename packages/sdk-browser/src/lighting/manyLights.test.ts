import assert from 'node:assert/strict';
import test from 'node:test';
import { createSceneLightStore, type SceneLight } from '../../../sdk-core/src/index.ts';
import { attachContractLights } from './contractLights.ts';
import { installLighting } from './contractLightingApi.ts';
import { declareImportedLights } from './importedLights.ts';
import { unsupportedClusterLight } from '../webgl/cluster/lights.ts';
import { GraphScene } from '../host/graph/scene.ts';
import { Object3D } from '../../../sdk-core/src/world/object/object3d.ts';

// #822: a scene declares as many lamps as it holds. The store takes every one of them and a
// file's lamps all arrive; WebGL2, until #835, refuses past its 64 slots out loud.

const lamps = (count: number): SceneLight[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `lamp${i}`,
    kind: 'point',
    position: [i, 2, 0],
    color: [1, 1, 1],
    intensity: 1,
    range: 10,
    castsShadow: i % 2 === 0,
  }));

test('300 imported lights: every one is declared, none dropped', () => {
  const store = createSceneLightStore();
  const declared = declareImportedLights(store, lamps(300));
  assert.equal(declared.length, 300);
  assert.equal(store.count, 300);
  assert.deepEqual(store.ids, declared);
});

test('WebGL2 past 64 lights raises its explicit error, never a silent drop', () => {
  const [scene, store] = [new GraphScene(), createSceneLightStore()];
  const contract = attachContractLights(
    scene,
    store,
    installLighting(scene, 0, new Object3D()),
    () => {},
  );
  for (const light of lamps(64)) store.add(light);
  contract.apply();
  assert.equal(unsupportedClusterLight(scene), undefined, '64 lights fit');
  store.add(lamps(65)[64]);
  contract.apply();
  assert.match(unsupportedClusterLight(scene)!, /65 light slots exceed the 64-light contract/);
});
