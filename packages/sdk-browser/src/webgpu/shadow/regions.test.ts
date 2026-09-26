// A page becomes one region, or two when its static layer is redrawn: each names its start and
// the casters its cull keeps, the second one's volume copied from the first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHADOW_CULL_FLOATS } from '../../../../sdk-core/src/index.ts';
import { SHADOW_CULL_CASTERS } from '../../../../sdk-core/src/scene/light-shadow/faces.ts';
import {
  DRAW_ALL,
  DRAW_DYNAMIC,
  DRAW_FULL,
} from '../../../../sdk-core/src/scene/light-shadow/pool.ts';
import { CASTERS_ALL, CASTERS_MOVING, CASTERS_STATIC } from '../../gpu/shadow/cullShader.ts';
import { createShadowRegionList, REGION_CLEAR, REGION_RESTORE, REGION_STATIC } from './regions.ts';
import { directShadowWgsl } from '../../lighting/direct/shadowWgsl.ts';

test('regions follow the draw mode: whole, layer then moving casters, or moving casters alone', () => {
  const list = createShadowRegionList(32);
  const volumes = new Float32Array(8 * SHADOW_CULL_FLOATS),
    words = new Uint32Array(volumes.buffer);
  volumes[0] = 42;
  assert.equal(list.push(33, DRAW_ALL, volumes, words), 1);
  volumes[SHADOW_CULL_FLOATS] = 7;
  assert.equal(list.push(34, DRAW_FULL, volumes, words), 2);
  assert.equal(list.push(35, DRAW_DYNAMIC, volumes, words), 1);
  const starts = [0, 1, 2, 3].map(list.startOf),
    casters = [0, 1, 2, 3].map((r) => words[r * SHADOW_CULL_FLOATS + SHADOW_CULL_CASTERS]);
  assert.deepEqual(starts, [REGION_CLEAR, REGION_STATIC, REGION_RESTORE, REGION_RESTORE]);
  assert.deepEqual(casters, [CASTERS_ALL, CASTERS_STATIC, CASTERS_MOVING, CASTERS_MOVING]);
  assert.equal(volumes[2 * SHADOW_CULL_FLOATS], 7, "the page's second region shares its volume");
  assert.deepEqual([list.pageOf(2), list.x(2), list.y(2)], [34, 2 * 128, 128]);
  assert.equal(list.layered, 1);
});

test('page 4 096 of a pool 64 pages a side opens its layer 1, where the shading reads it', () => {
  const list = createShadowRegionList(64);
  const volumes = new Float32Array(4 * SHADOW_CULL_FLOATS),
    words = new Uint32Array(volumes.buffer);
  for (const page of [4095, 4096, 4096 + 65]) list.push(page, DRAW_ALL, volumes, words);
  const place = (r: number) => [list.layer(r), list.x(r) / 128, list.y(r) / 128];
  assert.deepEqual([0, 1, 2].flatMap(place), [0, 63, 63, 1, 0, 0, 1, 1, 1]);
  // The shading's `shadowOffset`, the same place: the page within its layer, then the layer.
  const offset =
    /local=phys%\(side\*side\);\n.*f32\(local%side\),f32\(local\/side\).*f32\(phys\/\(side\*side\)\)/;
  assert.match(directShadowWgsl(8, null, 18), offset);
});
