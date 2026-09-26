// #364: what a world hands the engine for a sprite — its surface, its bounds, its row — so that
// every raster turns it to the camera and every culling test keeps it whichever way it turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { material } from '../../../../sdk-core/src/world/material/index.ts';
import { object } from '../../../../sdk-core/src/world/object/index.ts';
import { drawnTriangles } from '../../../../sdk-core/src/world/geometry/drawn.ts';
import type { GraphMesh } from '../../host/graph/mesh.ts';
import type { GraphSurface } from '../../host/graph/surface.ts';
import { clusterMaterialReason } from '../../host/surfaceGate.ts';
import type { HostAttributes } from '../../host/resources.ts';
import { BufferAttribute } from '../../../../sdk-core/src/world/buffer/attribute.ts';
import { importHostSurface } from '../../host/surfaceImport.ts';
import { hostSide } from '../../scene/materialSide.ts';
import { createPlacementRows, type PlacementRows } from '../../placement/rows.ts';
import { hostSurface, repaintHostSurface } from './worldSurface.ts';
import { buildWorldMirror } from './worldMirror.ts';
import { createWorldMaterials } from './worldMaterials.ts';
import { createWorldPoses } from './worldPoses.ts';
import type { Cut } from './worldCuts.ts';
import type { Seat } from './worldBatches.ts';
import { boxTransform } from '../../../../sdk-core/src/index.ts';
import { SPRITE_UNCULLED, spriteAt } from '../../visibility/shader/spriteWgsl.ts';
import { dagFixture } from '../../page/selection/dag.fixture.ts';
import { surfaceOf } from '../../page/surface.ts';
import { drawPasses } from '../../cluster/batchMesh.ts';
import { planCull } from '../../webgpu/blend/plan.ts';
import { blendSceneOf } from '../../webgpu/blend/plan.fixture.ts';
import type { BlendGpuItem } from '../../webgpu/blend/state.ts';
import { packed } from '../../gpu/dag/selectionHelpers.fixture.ts';
import { primitiveFrameWords, primitiveWordAt } from '../../gpu/dag/worlds.ts';

test('a sprite surface carries its turn and size rule, both sides, and a repaint writes its turn', () => {
  const picture = material.sprite({ rotation: 0.4, sizeAttenuation: false });
  const surface = hostSurface(picture, false, new Map(), 'sprite');
  assert.equal(surface.side, hostSide('double'), 'a quad turned to the camera has no back');
  const drawn = drawnTriangles(object.sprite().geometry, 'sprite')!;
  const attributes = {
    position: new BufferAttribute(drawn.positions, 3),
    normal: new BufferAttribute(drawn.normals, 3),
  } as unknown as HostAttributes;
  assert.equal(clusterMaterialReason(surface, attributes), undefined, 'the engine paths draw it');
  assert.deepEqual(importHostSurface(surface)?.sprite, { rotation: 0.4, sizeAttenuation: false });
  picture.rotation = 1.2;
  picture.sizeAttenuation = true;
  repaintHostSurface(surface, picture);
  // The size rule sets the root mark, taken once at collection: a repaint never moves it.
  assert.deepEqual(importHostSurface(surface)?.sprite, { rotation: 1.2, sizeAttenuation: false });
  // The same material worn by faces is no sprite.
  assert.equal(importHostSurface(hostSurface(picture, false, new Map()))?.sprite, undefined);
});

test("a sprite's rotation written at run time repaints its entry in place", () => {
  const table = createWorldMaterials();
  const cutout = material.sprite({ transparent: false, alphaTest: 0.5 });
  const entry = table.entryOf(cutout);
  cutout.rotation = 0.8;
  assert.equal(table.entryOf(cutout), entry);
  assert.deepEqual(table.takeRepainted(), [{ entry, values: true }]);
});

// The root mark (`spriteMark`) is taken once, when a session collects its roots: a size rule
// written at run time is a new entry, so the session opens again and every cut reads the new mark.
test("a sprite's size rule written at run time is a new entry, whose roots carry the new mark", () => {
  const table = createWorldMaterials();
  const cutout = material.sprite({ transparent: false, alphaTest: 0.5 });
  const marks: number[] = [];
  for (const sizeAttenuation of [true, false, true]) {
    const before = table.entryOf(cutout);
    cutout.sizeAttenuation = sizeAttenuation;
    const entry = table.entryOf(cutout);
    if (marks.length) assert.notEqual(entry, before, 'copied on write, never repainted');
    assert.deepEqual(table.takeRepainted(), []);
    const fixture = dagFixture();
    fixture.mesh.material = hostSurface(entry.material, false, new Map(), 'sprite');
    const { roots, dag } = packed(fixture);
    const frames = new Uint32Array(primitiveFrameWords(dag).buffer);
    assert.equal(roots[0].mark, dag.mark[0], 'the CPU cut root and the packed DAG agree');
    marks.push(frames[primitiveWordAt(0) + 3]);
    fixture.geometry.dispose();
  }
  assert.deepEqual(marks, [1, SPRITE_UNCULLED | 1, 1], 'the GPU frame word follows');
});

/** The host mesh a world builds for a sprite whose picture sits on its bottom-left corner. */
function spriteMesh() {
  const drawn = drawnTriangles(object.sprite().geometry, 'sprite', { center: [0, 0] })!;
  const cut = { key: 's', drawn, runtime: {} as never, users: new Set(), held: false } as Cut;
  const { root } = buildWorldMirror({
    placed: [{ cut, material: material.sprite(), rows: {} as PlacementRows, name: 's' }],
    models: [],
    rankOf: () => 0,
  });
  return root.children[0] as GraphMesh;
}

test("a sprite's host mesh wears the sprite surface and is bounded by its radius", () => {
  const mesh = spriteMesh();
  assert.ok(importHostSurface(mesh.material as GraphSurface)?.sprite);
  const { boundingBox, boundingSphere } = mesh.geometry;
  const r = Math.SQRT2;
  assert.deepEqual(boundingBox!.min.toArray(), [-r, -r, -r]);
  assert.deepEqual(boundingBox!.max.toArray(), [r, r, r]);
  assert.deepEqual([...boundingSphere!.center.toArray(), boundingSphere!.radius], [0, 0, 0, r]);
});

// #364 (measure ko): a transparent sprite drawn back then front took two entries of the
// transparent plan, whose per-frame ranking grows with the square of their count.
test('a transparent sprite is drawn in one pass: one plan entry, with no cull, and one WebGL2 pass', () => {
  const mesh = spriteMesh();
  const blendState = blendSceneOf(
    [0, 1, 2].map(
      (x) =>
        ({
          surface: surfaceOf(mesh.material),
          matrix: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1] },
          count: 6,
          paged: true,
        }) as unknown as BlendGpuItem,
    ),
  );
  assert.deepEqual([...blendState.orders[0]].map(planCull), [0, 0, 0]);
  assert.deepEqual(drawPasses(mesh.material), [undefined]);
});

test("a sprite's row keeps its position and axis lengths, never its turn", () => {
  const rows = createPlacementRows(2);
  const seat = (row: number) => ({ batch: { rows }, row }) as unknown as Seat;
  const poses = createWorldPoses();
  const sprite = object.sprite(),
    box = object.mesh(sprite.geometry);
  for (const node of [sprite, box]) {
    node.position.set(1, 2, 3);
    node.rotation.set(0.3, 1.1, -0.4);
    node.scale.set(3, 1.5, 0.25);
    node.updateMatrixWorld(true);
  }
  poses.writeSeat(sprite, seat(0), true);
  poses.writeSeat(box, seat(1), true);
  const row = Array.from(rows.matrices.subarray(0, 16)).map((v) => Math.round(v * 1e9) / 1e9);
  assert.deepEqual(row, [3, 0, 0, 0, 0, 1.5, 0, 0, 0, 1.5, 3, 0, 1, 2, 3, 1]);
  assert.deepEqual(
    Array.from(rows.matrices.subarray(16, 32)),
    Array.from(box.matrixWorld.elements),
  );
});

test("a tall sprite's row and page cube hold its quad under any camera and any rotation", () => {
  const rows = createPlacementRows(1);
  const poses = createWorldPoses();
  const sprite = object.sprite();
  sprite.position.set(1, 2, 3);
  sprite.scale.set(1, 4, 1);
  sprite.updateMatrixWorld(true);
  poses.writeSeat(sprite, { batch: { rows }, row: 0 } as unknown as Seat, true);
  const row = rows.matrices.subarray(0, 16);
  const drawn = drawnTriangles(sprite.geometry, 'sprite')!;
  const r = drawn.spriteRadius!;
  const box = new Float64Array([-r, -r, -r, r, r, r]);
  boxTransform(box, 0, box, 0, row);
  // Orthonormal views, column-major: the camera's right and up are their first two rows. The
  // last lays the camera's up along world x — a camera looking down, or one rolled a quarter.
  const views = [
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
    [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
  ];
  const corner = new Float64Array(4);
  for (const view of views)
    for (const rotation of [0, 0.7, Math.PI / 2])
      for (let i = 0; i < drawn.positions.length; i += 3) {
        spriteAt(corner, view, row, drawn.positions[i], drawn.positions[i + 1], {
          rotation,
          sizeAttenuation: true,
        });
        for (let axis = 0; axis < 3; axis++) {
          assert.ok(corner[axis] >= box[axis] - 1e-9, `corner below the box on axis ${axis}`);
          assert.ok(corner[axis] <= box[axis + 3] + 1e-9, `corner above the box on axis ${axis}`);
        }
      }
});
