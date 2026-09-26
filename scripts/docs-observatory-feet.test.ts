import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCacheManifest } from '../bench/runner/cacheManifest.ts';
import { decodeGeometryPage } from '../packages/sdk-browser/src/page/decode/geometryPage.ts';
import { IDENTITY_MATRIX4, boxCornersInto } from '../packages/sdk-core/src/math/index.ts';
import { sceneCacheFiles } from '../tests/kit/scenes/caches.ts';
import { bottom, top, type Part } from './docs/observatory/geometry.ts';
import { createObservatory, paving } from './docs/observatory/scene.ts';

const root = new URL('../', import.meta.url);
/** Contact tolerance: the sdk-core parts are single-precision, as the glTF is. */
const EPSILON = 1e-5;
const { parts } = createObservatory();
const blocks = parts.filter(({ kind }) => kind === 'block');
const where = (part: Part) => `${part.kind} ${part.min.map((c) => c.toFixed(3)).join(', ')}`;

/** Whether two parts share more than an edge along `axis`; a flat part counts when its plane
 *  lies inside the other's span. */
function across(a: Part, b: Part, axis: number) {
  const [a0, a1, b0, b1] = [a.min[axis], a.max[axis], b.min[axis], b.max[axis]];
  if (a1 - a0 < EPSILON) return b0 + EPSILON < a0 && a0 < b1 - EPSILON;
  if (b1 - b0 < EPSILON) return a0 + EPSILON < b0 && b0 < a1 - EPSILON;
  return Math.min(a1, b1) - Math.max(a0, b0) > EPSILON;
}
/** For each part, the parts under its footprint that reach its base: what carries it. */
const carriers = new Map(
  parts.map((part) => [
    part,
    parts.filter(
      (other) =>
        other !== part &&
        across(part, other, 0) &&
        across(part, other, 2) &&
        bottom(other) < bottom(part) &&
        bottom(part) <= top(other) + EPSILON,
    ),
  ]),
);
const supports = (part: Part) => carriers.get(part)!;

test('no block of the observatory overlaps another beyond contact', () => {
  const overlaps = blocks.flatMap((a, n) =>
    blocks
      .slice(n + 1)
      .filter((b) => [0, 1, 2].every((axis) => across(a, b, axis)))
      .map((b) => `${where(a)} into ${where(b)}`),
  );
  assert.deepEqual(overlaps, []);
});

test('every part stands on the part under it; a curved shell or a ring may be set into it', () => {
  const ground = parts.reduce((low, part) => (bottom(part) < bottom(low) ? part : low));
  for (const part of parts) {
    if (part === ground) continue;
    const under = supports(part);
    assert.ok(under.length, `${where(part)} floats: nothing under it reaches its base`);
    // A box or a turned part rests on its support's top: it neither floats nor sinks.
    if (part.kind === 'block' || part.kind === 'turned') {
      const sink = (support: Part) => top(support) - bottom(part);
      const nearest = under.reduce((a, b) => (Math.abs(sink(b)) < Math.abs(sink(a)) ? b : a));
      assert.ok(
        Math.abs(sink(nearest)) <= EPSILON,
        `${where(part)} sinks ${sink(nearest).toFixed(3)} m into ${where(nearest)}`,
      );
    }
  }
});

test('each arcade plinth rests on one paving stone, centred on it', () => {
  const extent = (part: Part, axis: number) => part.max[axis] - part.min[axis];
  const centre = (part: Part, axis: number) => (part.min[axis] + part.max[axis]) / 2;
  const stones = blocks.filter((block) =>
    paving.size.every((size, axis) => Math.abs(extent(block, axis) - size) < EPSILON),
  );
  // A plinth: the block a column's shaft stands on, itself on the paving.
  const plinths = new Set(
    parts
      .filter(({ kind }) => kind === 'turned')
      .flatMap(supports)
      .filter((part) => part.kind === 'block' && supports(part).some((s) => stones.includes(s))),
  );
  assert.equal(plinths.size, 8, 'two arcades of four plinths');
  for (const plinth of plinths) {
    const under = supports(plinth);
    assert.equal(under.length, 1, `${where(plinth)}: on one stone`);
    for (const axis of [0, 2])
      assert.ok(
        Math.abs(centre(plinth, axis) - centre(under[0], axis)) < EPSILON,
        `${where(plinth)}: centred on its stone`,
      );
  }
});

test("the compiled observatory decodes each block corner within its page's declared error", async () => {
  const [pointer] = (await sceneCacheFiles('manifest.json')).filter((file) =>
    file.startsWith('site/assets/gallery/signature-architecture/'),
  );
  assert.ok(pointer, 'the observatory cache is compiled (pnpm run compile:caches)');
  const { dir, manifest } = await readCacheManifest(fileURLToPath(new URL(dirname(pointer), root)));
  const out = new Float64Array(blocks.length * 24);
  blocks.forEach(({ min, max }, n) =>
    boxCornersInto(out, n * 24, min[0], min[1], min[2], max[0], max[1], max[2], IDENTITY_MATRIX4),
  );
  // Each corner as the source stores it, in single precision: the error a page declares is
  // measured from that.
  const corners = Array.from({ length: out.length / 3 }, (_, i) => [
    ...Float32Array.from(out.subarray(i * 3, i * 3 + 3)),
  ]);
  // The full-detail pages, decoded by the engine's own page decoder, each with the corners its
  // box holds and the largest distance it declares between a source position and its decoded
  // value (1e-4 m where it declares less): its grid's cost, not a loss.
  const holds = (min: number[], max: number[], at: number[], tolerance: number) =>
    at.every((c, axis) => c >= min[axis] - tolerance && c <= max[axis] + tolerance);
  const nearest = new Map(corners.map((at) => [at, Infinity]));
  for (const page of manifest.primitives.flatMap((primitive) => primitive.pages)) {
    if (page.role === 'coarse' || !page.geometry) continue;
    const pageCorners = corners.filter((at) => holds(page.min, page.max, at, 1e-3));
    if (!pageCorners.length) continue;
    const decoded = decodeGeometryPage(new Uint8Array(readFileSync(join(dir, page.geometry.url))));
    const { position } = decoded.attributes,
      tolerance = Math.max(1e-4, decoded.quantizationError);
    for (const at of pageCorners) {
      // How far past the page's error the nearest decoded vertex lies: 0 or less passes.
      let excess = nearest.get(at)!;
      for (let i = 0; i < position.length && excess > 0; i += 3)
        excess = Math.min(
          excess,
          Math.hypot(position[i] - at[0], position[i + 1] - at[1], position[i + 2] - at[2]) -
            tolerance,
        );
      nearest.set(at, excess);
    }
  }
  for (const [at, excess] of nearest)
    assert.ok(excess <= 0, `block corner ${at.join(', ')}: ${excess} m beyond its page's error`);
});
