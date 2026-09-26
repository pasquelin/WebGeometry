import test from 'node:test';
import assert from 'node:assert/strict';
import { geometry } from '../../../../sdk-core/src/world/geometry/index.ts';
import { drawnTriangles } from '../../../../sdk-core/src/world/geometry/drawn.ts';
import { LINE_DEPTH_LAYER } from '../../../../sdk-core/src/lod/depthLayer.ts';
import { cutRuntimePrimitive } from './runtimePrimitive.ts';
import { cutDrawnTriangles, packDrawn } from './runtimeCut.ts';
import { decodeGeometryPage } from '../../page/decode/geometryPage.ts';
import { BufferAttribute } from '../../../../sdk-core/src/world/buffer/attribute.ts';
import { LINE_DASH_GLSL, LINE_DASH_WGSL, lineDash } from '../../visibility/shader/lineWgsl.ts';
import { runShaderText } from '../../visibility/shader/shaderText.fixture.ts';

/** The depth layer of every page the world cuts from `drawn`. */
async function layers(drawn: NonNullable<ReturnType<typeof drawnTriangles>>) {
  const { primitive, urls } = await cutRuntimePrimitive(packDrawn(drawn), drawn);
  urls.forEach((url) => URL.revokeObjectURL(url));
  return primitive.pages.map((page) => page.depthLayer ?? 0);
}

// #348: line quads lie in the faces they outline; their pages draw one coplanar layer above them,
// on the same bias every path already applies. Faces keep the untouched layer 0.
test('the pages of line quads draw on the line layer, faces on layer 0', async () => {
  const box = geometry.box(1, 1, 1);
  const lines = await layers(drawnTriangles(geometry.edges(box), 'lineSegments')!);
  assert.ok(lines.length > 0);
  for (const layer of lines) assert.equal(layer, LINE_DEPTH_LAYER);
  for (const layer of await layers(drawnTriangles(box, 'triangles')!)) assert.equal(layer, 0);
});

// #359: a dashed line's distance along the line survives the cut: its pages carry it as their
// first texture coordinate, which every raster reads; a solid line's pages carry none.
test('the pages of a dashed line carry its distance along the line', async () => {
  const points = Array.from({ length: 9 }, (_, k) => [k * 0.5, 0, 0]).flat();
  const path = geometry.createBuffer({
    position: new BufferAttribute(new Float32Array(points), 3),
  });
  const read = async (dashed: boolean) => {
    const cut = await cutDrawnTriangles(drawnTriangles(path, 'lineStrip', { dashed })!, false);
    return cut.pages.map((page) => decodeGeometryPage(new Uint8Array(page.geometry)));
  };
  const [dashed] = await read(true);
  const along = [...new Set(Array.from(dashed.attributes.uv).filter((_, i) => i % 2 === 0))];
  assert.deepEqual(
    along.sort((a, b) => a - b),
    Array.from({ length: 9 }, (_, k) => k * 0.5),
  );
  for (const page of await read(false)) assert.equal(page.attributes.uv, undefined);
});

// #359: a line longer than the format's texture grid holds on one page (2^24 steps of 2^-14, 1024
// units) still draws, its dashes at their distances: the cut takes the finest grid its widest
// cluster fits, never dropping the page. Every dash text reads the decoded distance.
test('a dashed line past 1024 units keeps its dashes at their distances', async () => {
  const path = geometry.createBuffer({
    position: new BufferAttribute(new Float32Array([0, 0, 0, 1500, 0, 0, 3000, 0, 0]), 3),
  });
  const cut = await cutDrawnTriangles(drawnTriangles(path, 'lineStrip', { dashed: true })!, false);
  assert.equal(cut.pages.length, 1);
  // 3000 units on the finest grid that holds them, 2^-11; a textured box keeps the format's 2^-14.
  assert.equal(cut.uvExponent, -11);
  const box = await cutDrawnTriangles(drawnTriangles(geometry.box(1, 1, 1), 'triangles')!, false);
  assert.equal(box.uvExponent, -14);
  const { uv } = decodeGeometryPage(new Uint8Array(cut.pages[0].geometry)).attributes;
  const along = [...new Set(Array.from(uv!).filter((_, i) => i % 2 === 0))].sort((a, b) => a - b);
  assert.deepEqual(along, [0, 1500, 3000]);
  const runs = [
    runShaderText<boolean>(LINE_DASH_WGSL),
    runShaderText<boolean>(LINE_DASH_GLSL),
    (at: number, [dashSize, gapSize]: number[]) => lineDash(at, dashSize, gapSize),
  ];
  // Across the second segment, as a raster interpolates its corners: dash 0.3, gap 0.2.
  for (const run of runs)
    for (const [at, drawn] of [
      [2000.1, true],
      [2000.29, true],
      [2000.35, false],
      [2999.45, false],
      [2999.55, true],
    ] as const) {
      const t = (at - along[1]) / (along[2] - along[1]);
      const u = Math.fround(along[1] + t * (along[2] - along[1]));
      assert.equal(run(u, [0.3, 0.2]), drawn, `at ${at}`);
    }
});

// #364: a sprite's quad turns to the camera about its origin: its pages are bounded by the cube
// and the ball of its radius there, which hold it however it turns.
test("the pages of a sprite's quad are bounded by the cube of its radius", async () => {
  const drawn = drawnTriangles(geometry.plane(1, 1), 'sprite', { center: [0.5, 0] })!;
  const { primitive, urls } = await cutRuntimePrimitive(packDrawn(drawn), drawn);
  urls.forEach((url) => URL.revokeObjectURL(url));
  const r = Math.hypot(0.5, 1);
  for (const page of primitive.pages) {
    assert.deepEqual(
      [page.min, page.max, page.sphere],
      [
        [-r, -r, -r],
        [r, r, r],
        [0, 0, 0, r],
      ],
    );
    assert.equal(page.depthLayer, undefined);
  }
});
