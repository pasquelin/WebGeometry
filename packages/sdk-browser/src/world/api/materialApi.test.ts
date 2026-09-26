// The page reads a scene's materials as detached copies and sets them live: every listed value
// lands in each surface the scene built from the entry, the engine is asked to read them again,
// and a patch that would move the material to another draw class is refused before any write.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TableMaterial, TableTextureSlot } from '../../../../sdk-core/src/index.ts';
import * as G from '../../host/graph/graph.fixture.ts';
import { preparedMaterials } from '../../host/prepared/materials.ts';
import type { RenderBackend } from '../../backend/types.ts';
import { createExplorerMaterialApi } from './materialApi.ts';

const slot = (texture: number): TableTextureSlot => ({
  texture,
  texCoord: 0,
  slotTexCoord: 0,
  transform: null,
});

const entry = (overrides: Partial<TableMaterial>): TableMaterial => ({
  name: 'surface',
  derivativeTangents: false,
  kind: 'standard',
  alphaMode: 'OPAQUE',
  opacity: 1,
  extensions: {},
  lit: true,
  doubleSided: false,
  backSide: false,
  metalness: 0,
  roughness: 1,
  alphaTest: 0.5,
  normalScale: 1,
  normalScaleY: 1,
  aoIntensity: 1,
  transmission: 0,
  ior: 1.5,
  thickness: 0,
  attenuationDistance: 0,
  baseColor: [1, 1, 1],
  emissive: [0, 0, 0],
  attenuationColor: [1, 1, 1],
  map: null,
  metalnessMap: null,
  roughnessMap: null,
  normalMap: null,
  aoMap: null,
  emissiveMap: null,
  ...overrides,
});

/** Rank 0 opaque with its own map, worn in two geometry variants; rank 1 masked; ranks 2 and 3
 *  share one map; rank 4 blended. */
async function scene(refresh = true) {
  const textures = [new G.GraphTexture(), new G.GraphTexture()];
  const materialOf = preparedMaterials(
    [
      entry({ name: 'floor', map: slot(0), baseColor: [0.5, 0.5, 0.5] }),
      entry({ name: 'leaves', alphaMode: 'MASK', alphaTest: 0.5 }),
      entry({ name: 'left', map: slot(1) }),
      entry({ name: 'right', map: slot(1) }),
      entry({ name: 'glass', alphaMode: 'BLEND', opacity: 0.25 }),
    ],
    async (from) => textures[from.texture],
  );
  const plain = { vertexColors: false, flatShading: false };
  const source = new G.Group();
  const floor = [await materialOf(0, plain), await materialOf(0, { ...plain, vertexColors: true })];
  for (const surface of [
    ...floor,
    ...(await Promise.all([1, 2, 3, 4].map((r) => materialOf(r, plain)))),
  ])
    source.add(G.mesh(undefined, surface));
  let refreshed = 0;
  const backend = {
    id: 'webgpu-page-raster',
    ...(refresh && { refreshMaterials: () => void refreshed++ }),
  } as unknown as RenderBackend;
  const api = createExplorerMaterialApi({
    check: () => {},
    source,
    backends: [backend],
    active: () => backend,
  });
  return { api, floor, textures, refreshed: () => refreshed };
}

const refusal = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test('the scene materials are listed by table rank, each a detached copy', async () => {
  const { api, floor } = await scene();
  assert.deepEqual(
    api.materials().map(({ id, name, alphaMode }) => [id, name, alphaMode]),
    [
      ['0', 'floor', 'opaque'],
      ['1', 'leaves', 'mask'],
      ['2', 'left', 'opaque'],
      ['3', 'right', 'opaque'],
      ['4', 'glass', 'blend'],
    ],
  );
  const before = api.material('0');
  assert.deepEqual(before.tiling, [1, 1]);
  for (const read of [api.materials()[0], api.material('0'), api.importedMaterials()[0]]) {
    (read.baseColor as number[])[0] = 9;
    (read.emissive as number[])[1] = 9;
    (read.tiling as number[])[0] = 9;
    read.roughness = 0;
  }
  assert.deepEqual(api.material('0'), before);
  assert.deepEqual(api.importedMaterials()[0], before);
  assert.equal((floor[0].color as G.Color).r, 0.5);
  assert.throws(() => api.material('9'), refusal('UNKNOWN_MATERIAL'));
});

test('setMaterial writes each listed value into every surface of the material, live', async () => {
  const { api, floor, textures, refreshed } = await scene();
  const versions = floor.map((surface) => surface.version);
  api.setMaterial('0', {
    baseColor: [0.25, 0.5, 0.75],
    opacity: 0.5,
    metalness: 0.75,
    roughness: 0.25,
    emissive: [2, 1, 0],
    alphaMode: 'opaque',
    tiling: [4, 2],
  });
  assert.equal(refreshed(), 1, 'the engine reads the surfaces again');
  const read = api.material('0');
  assert.deepEqual(read.baseColor, [0.25, 0.5, 0.75]);
  assert.equal(read.opacity, 0.5);
  assert.equal(read.metalness, 0.75);
  assert.equal(read.roughness, 0.25);
  assert.deepEqual(read.emissive, [2, 1, 0]);
  assert.deepEqual(read.tiling, [4, 2]);
  assert.equal(read.alphaMode, 'opaque');
  for (const [i, surface] of floor.entries()) {
    assert.equal(surface.version, versions[i] + 1, 'every variant repainted in place');
    assert.equal((surface.color as G.Color).b, 0.75);
    assert.equal(surface.roughness, 0.25);
  }
  assert.deepEqual([textures[0].repeat.x, textures[0].repeat.y], [4, 2]);
  api.setMaterial('1', { alphaCutoff: 0.25 });
  assert.equal(api.material('1').alphaCutoff, 0.25);
  assert.equal(api.importedMaterials()[0].roughness, 1, 'the file values stay readable');
  assert.equal(api.importedMaterials()[1].alphaCutoff, 0.5);
});

test('a patch that would change the draw class is refused before any write', async () => {
  const { api, floor, refreshed } = await scene();
  const version = floor[0].version;
  for (const [id, patch] of [
    ['0', { alphaMode: 'blend', roughness: 0 }],
    ['0', { alphaMode: 'mask' }],
    ['1', { alphaMode: 'opaque' }],
    ['1', { alphaCutoff: 0 }],
    ['4', { alphaMode: 'opaque' }],
  ] as const)
    assert.throws(() => api.setMaterial(id, patch), refusal('MATERIAL_CLASS_CHANGE'));
  assert.equal(floor[0].version, version);
  assert.equal(api.material('0').roughness, 1);
  assert.equal(refreshed(), 0);
  api.setMaterial('0', { alphaCutoff: 0.5 });
  assert.equal(api.material('0').alphaMode, 'opaque', 'a cutoff never masks an opaque material');
});

test('setMaterial refuses by name what it cannot apply to this material alone', async () => {
  const { api } = await scene();
  assert.throws(() => api.setMaterial('9', { roughness: 0 }), refusal('UNKNOWN_MATERIAL'));
  assert.throws(() => api.setMaterial('0', { roughness: 2 }), refusal('INVALID_MATERIAL'));
  assert.throws(() => api.setMaterial('0', { tiling: [0, 1] }), refusal('INVALID_MATERIAL'));
  assert.throws(() => api.setMaterial('1', { tiling: [2, 2] }), refusal('INVALID_MATERIAL'));
  assert.throws(() => api.setMaterial('2', { tiling: [2, 2] }), refusal('MATERIAL_TEXTURE_SHARED'));
  const { api: fixed } = await scene(false);
  assert.throws(
    () => fixed.setMaterial('0', { roughness: 0 }),
    refusal('UNSUPPORTED_SCENE_UPDATE'),
  );
  assert.equal(fixed.material('0').roughness, 1);
});
