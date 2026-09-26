import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../host/graph/graph.fixture.ts';
import { planCull, planPipeline, planVertexCull } from './plan.ts';
import { blendSceneOf } from './plan.fixture.ts';
import { hostBlending } from '../../scene/materialBlending.ts';
import type { BlendGpuItem } from './state.ts';
import { surfaceOf } from '../../page/surface.ts';

/** The blend plan of a lone item, everything but its material left at its simplest. */
function plan(
  material: G.GraphSurface | G.GraphSurface[],
  { transmissive = false, paged = false } = {},
) {
  const blendState = blendSceneOf([
    {
      transmissive,
      surface: surfaceOf(material),
      matrix: new G.Matrix4(),
      count: 3,
      paged,
    } as unknown as BlendGpuItem,
  ]);
  return [...blendState.orders[transmissive ? 1 : 0]];
}

test('an item that declares no material plans the host default side: one front entry, not a crash', () => {
  const front = plan(G.basicSurface({ side: G.FRONT_SIDE }));
  assert.equal(front.length, 1);
  assert.deepEqual(plan([]), front, 'an empty material array declares nothing: front');
});

// #346: an entry picks the pipelines of its item's mode — three culls per mode, normal first.
test('an item plans on the pipelines of its blend mode; a mode no path draws is refused', () => {
  const pipelineOf = (blending: number, transmissive = false) =>
    plan(G.basicSurface({ transparent: true, blending }), { transmissive }).map(planPipeline);
  const normal = pipelineOf(hostBlending('normal'));
  assert.deepEqual(
    pipelineOf(hostBlending('additive')),
    normal.map((p) => p + 3),
  );
  assert.deepEqual(
    pipelineOf(hostBlending('multiply')),
    normal.map((p) => p + 9),
  );
  assert.deepEqual(
    pipelineOf(hostBlending('none')),
    normal.map((p) => p + 12),
  );
  assert.deepEqual(pipelineOf(hostBlending('normal'), true), normal);
  assert.throws(() => pipelineOf(5), /blending no path draws/);
  assert.throws(() => pipelineOf(hostBlending('additive'), true), /cannot use additive/);
});

test('a double-sided paged item plans back then face on the pipeline that culls nothing', () => {
  const entries = plan(G.basicSurface({ side: G.DOUBLE_SIDE }), { paged: true });
  // Back first: the pass culls the face (1), then the back (2); the vertex stage applies both.
  assert.deepEqual(entries.map(planCull), [1, 2]);
  assert.deepEqual(entries.map(planPipeline), [0, 0]);
  assert.deepEqual(entries.map(planVertexCull), [1, 2]);
});

test('a double-sided unpaged item keeps the hardware cull of its two pipelines', () => {
  const entries = plan(G.basicSurface({ side: G.DOUBLE_SIDE }));
  assert.deepEqual(entries.map(planPipeline), [1, 2]);
  assert.deepEqual(entries.map(planVertexCull), [0, 0]);
});

test("a double-sided paged item of another mode sets that mode's pipeline that culls nothing", () => {
  const entries = plan(
    G.basicSurface({ side: G.DOUBLE_SIDE, transparent: true, blending: hostBlending('additive') }),
    { paged: true },
  );
  assert.deepEqual(entries.map(planCull), [1, 2]);
  assert.deepEqual(entries.map(planPipeline), [3, 3]);
  assert.deepEqual(entries.map(planVertexCull), [1, 2]);
});
