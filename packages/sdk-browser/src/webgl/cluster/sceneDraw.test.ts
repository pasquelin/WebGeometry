import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneDraw } from './sceneDraw.ts';
import { createTestContext } from '../core/testContext.fixture.ts';
import { createHostDrawCamera, type HostCamera } from '../../camera/world.ts';
import { GraphScene } from '../../host/graph/scene.ts';
import { GraphInstancedMesh, GraphMesh } from '../../host/graph/mesh.ts';
import { GraphCamera } from '../../host/graph/camera.ts';
import { readHostDrawCamera } from '../../camera/world.ts';
import { BufferAttribute } from '../../../../sdk-core/src/world/buffer/attribute.ts';
import { GraphSurface } from '../../host/graph/surface.ts';
import { Group } from '../../../../sdk-core/src/world/object/object3d.ts';
import { Geometry } from '../../../../sdk-core/src/world/geometry/geometry.ts';

const OUTPUT = { toneMapped: false, framebuffer: null, width: 8, height: 4 };

/** A mesh of `corners` indices — its count names it in the recorded draws. */
function mesh(corners: number, renderOrder: number, surface = new GraphSurface('standard')) {
  const geometry = new Geometry().setIndex(new BufferAttribute(new Uint32Array(corners), 1));
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(9), 3));
  const made = new GraphMesh(geometry, surface);
  made.renderOrder = renderOrder;
  made.frustumCulled = false;
  return made;
}

function drawn(scene: GraphScene) {
  const context = createTestContext();
  const draw = createSceneDraw(context.gl, scene);
  assert.equal(draw.counters(), null, 'no count before the first frame');
  assert.throws(
    () => draw.host.drawHostGeometry(createHostDrawCamera(), OUTPUT),
    /Draw before render/,
  );
  draw.render({} as HostCamera);
  draw.host.drawHostGeometry(createHostDrawCamera(), OUTPUT);
  return { context, draw };
}

test('the opaque meshes draw by order, the see-through ones after, a hidden one never', () => {
  const scene = new GraphScene();
  const glass = mesh(9, 0, new GraphSurface('standard', { transparent: true, opacity: 0.5 }));
  const hidden = mesh(12, 0);
  hidden.visible = false;
  scene.add(mesh(3, 1), glass, mesh(6, 0), hidden);
  const { context, draw } = drawn(scene);
  assert.deepEqual(
    context.of('drawElements').map((args) => args[1]),
    [6, 3, 9],
  );
  assert.deepEqual(draw.counters(), { triangles: 6 });
  draw.dispose();
});

test('an instanced mesh is one submission of every placement it counts', () => {
  const scene = new GraphScene();
  const source = mesh(6, 0);
  const placed = new GraphInstancedMesh(source.geometry, source.material as GraphSurface, 4);
  placed.count = 3;
  scene.add(placed);
  const { context, draw } = drawn(scene);
  assert.deepEqual(
    context.of('drawElementsInstanced').map((args) => [args[1], args[4]]),
    [[6, 3]],
  );
  assert.deepEqual(draw.counters(), { triangles: 6 });
  assert.equal(context.of('vertexAttribDivisor').length, 4, 'one divisor per matrix column');
  draw.dispose();
});

test('without a context the draw is refused by name', () => {
  const draw = createSceneDraw(undefined, new GraphScene());
  draw.render({} as HostCamera);
  assert.throws(
    () => draw.host.drawHostGeometry(createHostDrawCamera(), OUTPUT),
    /HOST_SURFACE_MISSING/,
  );
});

// Issue #275: a mesh under a moved parent draws at its WORLD placement, as the reference draws it
// — never at its own local matrix.
test('a mesh under a translated and rotated group draws where the reference draws it', async () => {
  const three = await import('three');
  const pose = (
    node: {
      position: { set(x: number, y: number, z: number): unknown };
      rotation: { set(x: number, y: number, z: number): unknown };
    },
    p: number[],
    r: number[],
  ) => {
    node.position.set(p[0], p[1], p[2]);
    node.rotation.set(r[0], r[1], r[2]);
  };
  const scene = new GraphScene(),
    group = new Group(),
    child = mesh(3, 0),
    witness = new three.Group(),
    witnessChild = new three.Mesh();
  pose(group, [4, -1, -6], [0.3, 0.9, 0]);
  pose(witness, [4, -1, -6], [0.3, 0.9, 0]);
  pose(child, [1, 2, -3], [0, 0, 0.4]);
  pose(witnessChild, [1, 2, -3], [0, 0, 0.4]);
  group.add(child);
  scene.add(group);
  witness.add(witnessChild);
  witness.updateMatrixWorld();
  const context = createTestContext(),
    draw = createSceneDraw(context.gl, scene),
    camera = new GraphCamera({ fov: 60, aspect: 1, near: 0.1, far: 100 });
  draw.render({} as HostCamera);
  draw.host.drawHostGeometry(readHostDrawCamera(createHostDrawCamera(), camera), OUTPUT);
  const uploaded = context
    .of('uniformMatrix4fv')
    .find((args) => (args[0] as { uniform: string }).uniform === 'modelViewMatrix')!;
  const expected = new Float32Array(witnessChild.matrixWorld.elements);
  assert.deepEqual(Array.from(uploaded[2] as Float32Array), Array.from(expected));
  draw.dispose();
});

// #337: a glass — a physical surface that transmits — is drawn, never dropped: the opaque meshes
// are first drawn into the frozen backdrop, then on the display, and the glass last, reading it.
test('a transmissive copy draws over the backdrop the opaque meshes were drawn into first', () => {
  const context = createTestContext({
    answers: {
      getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? {} : null),
      getParameter: (name: string) => (name === 'VIEWPORT' ? new Int32Array([0, 0, 8, 4]) : null),
      isEnabled: () => false,
    },
  });
  const glass = mesh(9, 0, new GraphSurface('physical', { transmission: 1, roughness: 0 }));
  const scene = new GraphScene();
  scene.add(mesh(6, 0), glass);
  const draw = createSceneDraw(context.gl, scene, [glass]);
  draw.render({} as HostCamera);
  draw.host.drawHostGeometry(createHostDrawCamera(), OUTPUT);
  const submitted = context.calls.filter((call) =>
    ['drawElements', 'bindFramebuffer', 'uniform1i'].includes(call.name),
  );
  const at = (count: number) =>
    submitted.findIndex((call) => call.name === 'drawElements' && call.args[1] === count);
  assert.deepEqual(
    context.of('drawElements').map((args) => args[1]),
    [6, 6, 9],
    'backdrop, display, then the glass',
  );
  const backdrop = submitted.findIndex(
    (call) => call.name === 'bindFramebuffer' && call.args[1] !== null,
  );
  assert.ok(backdrop >= 0 && backdrop < at(6), 'the backdrop is bound before the first draw');
  const transmits = submitted.findLastIndex(
    (call) =>
      call.name === 'uniform1i' && (call.args[0] as { uniform: string }).uniform === 'transmissive',
  );
  assert.equal(submitted[transmits].args[1], 1, 'the glass is drawn transmitting');
  assert.ok(transmits < at(9));
  assert.deepEqual(draw.counters(), { triangles: 7 });
  draw.dispose();
});

// #348: a line's width counts CSS pixels. The WebGL2 program widens a line surface's quads by its
// `lineWidth` times the host's pixel ratio, read each frame, in the viewport of the image. #359:
// a dashed line's dash and gap reach the fragment stage, which discards its gaps.
test('a line surface draws with its CSS width, the host pixel ratio and its dash', () => {
  const context = createTestContext(),
    scene = new GraphScene(),
    lines = new GraphSurface('basic', { side: 2 });
  Object.assign(lines, { lineWidth: 3, dashSize: 0.25, gapSize: 0.5 });
  scene.add(mesh(6, 0, lines));
  let ratio = 2;
  const draw = createSceneDraw(context.gl, scene, [], { pixelRatio: () => ratio });
  const uniform = (name: string) =>
    context
      .of('uniform1f')
      .filter((args) => (args[0] as { uniform: string }).uniform === name)
      .map((args) => args[1]);
  for (const frame of [2, 1.5]) {
    ratio = frame;
    draw.render({} as HostCamera);
    draw.host.drawHostGeometry(createHostDrawCamera(), OUTPUT);
  }
  assert.deepEqual(uniform('pixelRatio'), [2, 1.5], 'each frame reads the ratio');
  assert.deepEqual(uniform('lineWidth'), [3]);
  const viewport = context
    .of('uniform2f')
    .find((args) => (args[0] as { uniform: string }).uniform === 'viewport');
  assert.deepEqual(viewport?.slice(1), [8, 4]);
  const dash = context
    .of('uniform2f')
    .find((args) => (args[0] as { uniform: string }).uniform === 'dash');
  assert.deepEqual(dash?.slice(1), [0.25, 0.5]);
  draw.dispose();
});
