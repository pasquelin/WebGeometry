// The dispatch bench asserts the former cut and the shipped one draw the same pages. They differ in
// their descent alone: the former drops no subtree on its error floor (`floorWgsl.ts`), the
// shipped one does. So the bench's scene must draw a cut no such drop changes, or the assertion
// measures the descents' difference instead of a regression. Played here on the engine's Node
// mirror of the kernel: a scene whose residency said every finer group missing drew each coarse
// page the former descent kept, 11,905 pages against 6,000 (#486).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCH_SCENE, sceneView } from '../../../tests/browser/probes/cutDispatchesScene.ts';
import { evaluateDagSelectionKernel } from '../../../packages/sdk-browser/src/gpu/dag/selection.ts';
import { DAG_NODE_FLOATS } from '../../../packages/sdk-browser/src/gpu/dag/types.ts';
import { NODE_FLOOR } from '../../../packages/sdk-browser/src/gpu/dag/packNodes.ts';

test('the dispatch scene draws the same cut whether the descent drops on the floor or not', () => {
  const { packed, uniforms, resident } = sceneView(DISPATCH_SCENE.feuilles, DISPATCH_SCENE.niveaux);
  const drawn = (nodes: Float32Array) =>
    evaluateDagSelectionKernel({ ...packed, nodes }, uniforms, resident).drawablePageIds;
  // A zero floor drops nothing: the former descent's verdicts.
  const noFloor = packed.nodes.slice();
  for (let n = 0; n < packed.nodeCount; n++) noFloor[n * DAG_NODE_FLOATS + NODE_FLOOR] = 0;
  const shipped = drawn(packed.nodes);
  assert.ok(shipped?.length, 'the scene must draw pages');
  assert.deepEqual(drawn(noFloor), shipped);
});
