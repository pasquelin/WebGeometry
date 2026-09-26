import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../host/graph/graph.fixture.ts';
import { surfaceOf } from '../../page/surface.ts';
import type { PlacementOf } from '../../placement/rows.ts';
import { buildBlendStatics, refreshBlendPlan } from './plan.ts';
import { orderBlendPasses } from './order.ts';
import { blendSceneOf } from './plan.fixture.ts';
import { createWebgpuBlendState, type BlendGpuItem } from './state.ts';

type BlendState = ReturnType<typeof createWebgpuBlendState>;
/** A key no ranking computes: still on an item after a frame, that frame did not rank. */
const UNRANKED = -1;

/** A paged double-sided item whose box is centred on `z`, the one input its rank reads. */
function item(z: number, extra: Partial<BlendGpuItem> = {}) {
  return {
    surface: surfaceOf(G.basicSurface({ side: 2 })),
    matrix: new G.Matrix4(),
    count: 3,
    paged: true,
    bounds: new Float64Array([-1, -1, z - 1, 1, 1, z + 1]),
    ...extra,
  } as unknown as BlendGpuItem;
}

/** Everything a ranking hands the frame: order, runs, mask, reject and water counts. */
function outcome(blendState: BlendState, rejected: number) {
  return {
    rejected,
    orders: blendState.orders.map((order) => Array.from(order)),
    runs: blendState.runs.map((runs, pass) =>
      Array.from(runs.subarray(0, blendState.runCount[pass] * 4)),
    ),
    runCount: [...blendState.runCount],
    keep: Array.from(blendState.keepPacked),
    transmissiveInView: blendState.transmissiveInView,
  };
}

/** Ranks `blendState` and a fresh scene of the same items and planes, from source order. */
function rankAgainstFresh(blendState: BlendState, eye: number[]) {
  const kept = outcome(blendState, orderBlendPasses(blendState, eye));
  const ranked = blendState.blendGpu.every((entry) => entry.orderKey !== UNRANKED);
  const fresh = blendSceneOf([...blendState.blendGpu]);
  fresh.blendPlanes.set(blendState.blendPlanes);
  assert.deepEqual(
    kept,
    outcome(fresh, orderBlendPasses(fresh, eye)),
    'bit-identical to a full ranking',
  );
  return ranked;
}

/** A scene ranked twice from the same eye: its inputs are on record, and the next frame skips. */
function heldScene(items = [item(-4), item(-8), item(-2), item(-6)]) {
  const blendState = blendSceneOf(items);
  // Rejects every box beyond z = 3: none of the four, but a moved one can be.
  blendState.blendPlanes.set([0, 0, -1, 3]);
  const eye = [0, 0, 0];
  orderBlendPasses(blendState, eye);
  orderBlendPasses(blendState, eye);
  for (const entry of blendState.blendGpu) entry.orderKey = UNRANKED;
  return { blendState, eye };
}

test('a still view with still items keeps the last order, bit-identical to a full ranking', () => {
  const { blendState, eye } = heldScene();
  assert.equal(rankAgainstFresh(blendState, eye), false, 'the frame did not rank again');
});

test('the first still frame after a move ranks, the second keeps', () => {
  const blendState = blendSceneOf([item(-4), item(-8)]);
  orderBlendPasses(blendState, [0, 0, 0]);
  orderBlendPasses(blendState, [0, 0, -9]);
  for (const entry of blendState.blendGpu) entry.orderKey = UNRANKED;
  assert.equal(rankAgainstFresh(blendState, [0, 0, -9]), true, 'items were not on record yet');
  for (const entry of blendState.blendGpu) entry.orderKey = UNRANKED;
  assert.equal(rankAgainstFresh(blendState, [0, 0, -9]), false);
});

const changes: [string, (scene: ReturnType<typeof heldScene>) => void][] = [
  ['the eye moves', (scene) => (scene.eye = [0, 0, -9])],
  ['a frustum plane moves', ({ blendState }) => blendState.blendPlanes.set([0, 0, -1, 5])],
  [
    'a box moves in place',
    ({ blendState }) => blendState.blendGpu[0].bounds!.set([-1, -1, 4, 1, 1, 6]),
  ],
  ['a box is dropped', ({ blendState }) => (blendState.blendGpu[1].bounds = undefined)],
  [
    'a row is parked',
    ({ blendState }) => ((blendState.blendGpu[2].placement as PlacementOf).rows.live[0] = 0),
  ],
  ['its node is hidden', ({ blendState }) => (blendState.blendGpu[1].hidden = true)],
  ['the plan is rebuilt', ({ blendState }) => refreshBlendPlan(blendState)],
  [
    'an item joins',
    ({ blendState }) => {
      blendState.blendGpu.push(item(-3));
      buildBlendStatics(blendState);
      refreshBlendPlan(blendState);
    },
  ],
];

for (const [what, change] of changes)
  test(`${what}: the frame ranks again, as a full ranking would`, () => {
    const row = { rows: { live: new Uint8Array([1]) }, index: 0 } as unknown as PlacementOf;
    const scene = heldScene([item(-4), item(-8), item(-2, { placement: row }), item(-6)]);
    change(scene);
    assert.equal(rankAgainstFresh(scene.blendState, scene.eye), true);
  });

test('an item without a box ranks again when its world origin moves', () => {
  const { blendState, eye } = heldScene([item(-4), item(-8, { bounds: undefined })]);
  (blendState.blendGpu[1].matrix.elements as number[])[14] = -1;
  assert.equal(rankAgainstFresh(blendState, eye), true);
});

test('an item that turns transmissive ranks again: the water count follows', () => {
  const { blendState, eye } = heldScene();
  blendState.blendGpu[0].transmissive = true;
  orderBlendPasses(blendState, eye);
  assert.notEqual(blendState.blendGpu[0].orderKey, UNRANKED);
  assert.equal(blendState.transmissiveInView, 1);
});

test('a frame without an eye voids the record', () => {
  const { blendState, eye } = heldScene();
  orderBlendPasses(blendState, undefined);
  assert.equal(rankAgainstFresh(blendState, eye), true);
});

test('the first frame with an eye after one without slices the runs again, its order unmoved', () => {
  const { blendState, eye } = heldScene();
  blendState.orderMoved = [false, false];
  orderBlendPasses(blendState, undefined);
  orderBlendPasses(blendState, eye);
  assert.ok(blendState.runCount[0] > 0, 'the transparents are drawn again');
  assert.equal(blendState.orderMoved[0], true, 'the new runs are uploaded');
});
