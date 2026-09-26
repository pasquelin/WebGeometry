import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CommandWriter, PHYSICS_STEP, SHAPE } from '../packages/sdk-core/src/physics/index.ts';
import {
  body,
  standCharacter,
  startModule,
} from '../packages/sdk-browser/src/physics/module.fixture.ts';

type Gltf = {
  accessors: { bufferView: number; componentType: number; count: number; type: string }[];
  bufferViews: { byteOffset: number }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices: number }[] }[];
  nodes: { mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[] }[];
};
type Mesh = { vertices: Float32Array; indices: Uint32Array };

const FLOAT = 5126,
  UINT32 = 5125;
const hall = new URL('../site/assets/examples/hall/source/', import.meta.url);

/** The hall's own triangles, from its committed source: what its cook collides with. */
async function hallTriangles(): Promise<Mesh[]> {
  const [text, bin] = await Promise.all([
    readFile(new URL('geometry.gltf', hall), 'utf8'),
    readFile(new URL('scene.bin', hall)),
  ]);
  const gltf = JSON.parse(text) as Gltf;
  const placed = gltf.nodes.filter((node) => node.mesh !== undefined);
  assert.deepEqual(placed, [{ mesh: 0, name: 'scene' }], 'one untransformed node holds the hall');
  const read = (accessor: number, kind: number) => {
    const { bufferView, componentType, count, type } = gltf.accessors[accessor];
    assert.equal(componentType, kind, `accessor ${accessor}: component type ${componentType}`);
    const offset = bin.byteOffset + gltf.bufferViews[bufferView].byteOffset;
    const length = count * (type === 'VEC3' ? 3 : 1);
    return kind === FLOAT
      ? new Float32Array(bin.buffer, offset, length)
      : new Uint32Array(bin.buffer, offset, length);
  };
  return gltf.meshes[0].primitives.map(({ attributes, indices }) => ({
    vertices: read(attributes.POSITION, FLOAT) as Float32Array,
    indices: read(indices, UINT32) as Uint32Array,
  }));
}

/** The walls the page adds to the hall, read from the page as it is served: centre x, y, z,
 *  then width, height, depth each. */
async function pageWalls() {
  const html = await readFile(
    new URL('../site/examples/a-walker-among-balls.html', import.meta.url),
    'utf8',
  );
  const list = /const hallWalls = (\[[\s\S]*?\]);/.exec(html)?.[1];
  assert.ok(list, 'the page closes the hall with walls of its own');
  return JSON.parse(list.replace(/,(\s*\])/g, '$1')) as number[][];
}

/** The page's scene in a fresh module: the hall's triangles, its walls as static boxes, the human
 *  character standing where the page puts the eye. */
async function hallWorld(meshes: Mesh[], walls: number[][]) {
  const jolt = await startModule();
  const writer = new CommandWriter();
  writer.gravity([0, -9.81, 0]);
  let id = 0;
  for (const { vertices, indices } of meshes)
    writer.add({
      ...body(id++, 0, 0, 1),
      shape: SHAPE.triangles,
      vertices: Array.from(vertices),
      indices: Array.from(indices),
    });
  for (const [x, y, z, width, height, depth] of walls)
    writer.add({
      ...body(id++, 0, y, 1),
      position: [x, y, z],
      size: [width / 2, height / 2, depth / 2],
    });
  return { jolt, driver: standCharacter(jolt, writer.take(), [2.5, 0, 0]) };
}

test('the walker stays in the hall whichever way it walks: its walls stop it, its floor holds it', async () => {
  const [meshes, walls] = await Promise.all([hallTriangles(), pageWalls()]);
  for (let heading = 0; heading < 8; heading++) {
    const { jolt, driver } = await hallWorld(meshes, walls);
    const angle = (heading * Math.PI) / 4;
    driver.press({ wishX: Math.cos(angle), wishZ: Math.sin(angle), sprint: true }, 0);
    // Long enough to cross the hall four times at a sprint.
    for (let t = 0; t < 8; t += PHYSICS_STEP) {
      jolt.step(driver.command(PHYSICS_STEP, jolt.active() > 0), PHYSICS_STEP);
      const state = jolt.character();
      driver.read(state, PHYSICS_STEP);
      const [, x, y, z] = state;
      assert.ok(y > -0.05, `heading ${heading * 45}°: below the floor at y = ${y}`);
      const out = Math.max(Math.abs(x), Math.abs(z));
      assert.ok(out < 5, `heading ${heading * 45}°: out at ${x}, ${z}`);
    }
  }
});
