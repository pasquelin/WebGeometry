// #772, measure ko: on WebGL2 a physical surface declaring a feature the program cannot draw —
// clearcoat first — stopped automatic rendering. It is now drawn without that feature, every
// frame, and the world says so once per surface and feature; WebGPU is not involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../host/graph/graph.fixture.ts';
import { EffectChain } from '../../../../sdk-core/src/world/effect/chain.ts';
import { GraphScene } from '../../host/graph/scene.ts';
import { GraphSurface } from '../../host/graph/surface.ts';
import { heard, session } from './composeSession.fixture.ts';

test('a clearcoat surface is drawn on WebGL2, said once, the loop never stopped', async () => {
  const coat = new GraphSurface('physical', { clearcoat: 1, clearcoatRoughness: 0.1 });
  const scene = new GraphScene().add(G.triangleMesh(coat), G.triangleMesh(coat));
  const view = session(scene, new EffectChain());
  const said = await heard(view, () => {
    for (let frame = 0; frame < 3; frame++)
      assert.deepEqual(view.frame(), { chained: false, submitted: 2 });
    // A second feature of the same surface is its own notice; a known one is never said again.
    coat.sheen = 1;
    assert.deepEqual(view.frame(), { chained: false, submitted: 2 });
    assert.deepEqual(view.frame(), { chained: false, submitted: 2 });
  });
  assert.deepEqual(said, ['material-degraded', 'material-degraded']);
});

test('a surface with no feature WebGL2 lacks says nothing', async () => {
  const scene = new GraphScene().add(
    G.triangleMesh(new GraphSurface('physical')),
    G.triangleMesh(new GraphSurface('standard')),
  );
  const view = session(scene, new EffectChain());
  const said = await heard(view, () => {
    assert.deepEqual(view.frame(), { chained: false, submitted: 2 });
  });
  assert.deepEqual(said, []);
});
