import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { geometry } from '../../../../sdk-core/src/world/geometry/index.ts';
import { drawnTriangles } from '../../../../sdk-core/src/world/geometry/drawn.ts';
import { prepareSdkWasm } from '../../page/decode/geometryPageWasm.ts';
import { triangleCone } from '../../../../../tests/kit/cone.ts';
import { cutRuntimePrimitive } from './runtimePrimitive.ts';
import { cutDrawnTriangles, packDrawn } from './runtimeCut.ts';

// #828: a page the world cuts at run time carries the cone of its triangles' normals, built by
// the compiler's `triangle_cone` in the SDK module. Node cannot fetch the module by its URL: the
// test hands it the bytes, as the page decoder's tests do.
await prepareSdkWasm(readFileSync(join(import.meta.dirname, '../../page/decode/pageCodec.wasm')));

/** The float64 words of `values`: bit for bit, and ulps apart for two numbers of one sign. */
const words = (values: number[]) =>
  Array.from(new BigUint64Array(Float64Array.from(values).buffer));
/** Ulps an angle may stand above the runtime's: twice `ANGLE_MARGIN_ULPS` (4, `normal_cone.rs`),
 *  the bound the cooked cones are held to (`tests/integration/cooked-cones.test.ts`). */
const WIDEST = 2n * 4n;

test('every cut page carries the cone triangle_cone builds on its own triangles', async () => {
  const drawn = drawnTriangles(geometry.sphere(1, 32, 16), 'triangles')!;
  const cut = await cutDrawnTriangles(drawn);
  assert.ok(cut.pages.length > 1, 'the sphere spans several clusters');
  for (const page of cut.pages) {
    const built = triangleCone(drawn.positions, new Uint32Array(page.index));
    const cone = words([...page.cone!.axis, page.cone!.angle]),
      expected = words([...built.axis, built.angle]);
    assert.deepEqual(cone.slice(0, 3), expected.slice(0, 3), 'the same axis, bit for bit');
    const wider = cone[3] - expected[3];
    assert.ok(wider >= 0n && wider <= WIDEST, `an angle ${wider} ulps wider`);
  }
});

test('the served pages keep their cone, but those of line and sprite quads', async () => {
  const box = geometry.box(1, 1, 1);
  const serve = async (drawn: NonNullable<ReturnType<typeof drawnTriangles>>) => {
    const { primitive, urls } = await cutRuntimePrimitive(packDrawn(drawn), drawn);
    urls.forEach((url) => URL.revokeObjectURL(url));
    return primitive.pages.map((page) => page.cone);
  };
  const faces = await serve(drawnTriangles(box, 'triangles')!);
  assert.ok(faces.length > 0 && faces.every((cone) => cone !== undefined));
  for (const drawn of [
    drawnTriangles(geometry.edges(box), 'lineSegments')!,
    drawnTriangles(geometry.plane(1, 1), 'sprite')!,
  ])
    for (const cone of await serve(drawn)) assert.equal(cone, undefined);
});
