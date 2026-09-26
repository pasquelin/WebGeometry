import test from 'node:test';
import assert from 'node:assert/strict';
import { LIGHT_SETTINGS } from '../../../../sdk-core/src/index.ts';
import { LIGHT_TILES_SHADER } from './shader.ts';
import {
  compactTile,
  tileLayout,
  tileLists,
} from '../../../../../bench/oracles/browser/gpuLightTilesRankOracle.ts';

// D4, #28 and #822: shader.ts compacts each kept light at its rank (countOneBits, one thread per
// light, 256 lights a batch) into lists of `tileLights`; a tile more lights reach walks them all.
// The oracle ports that compaction on the layout the shader declares, so a record too small for
// its lights fails here.

const layout = tileLayout(LIGHT_TILES_SHADER);
const MAX = LIGHT_SETTINGS.tileLights;

/** What each slice keeps: `opaque` and `blend` list the lights by rank. */
const mask = (opaque: Iterable<number>, blend: Iterable<number>) => ({ opaque, blend });
const range = (n: number, keep = (_: number) => true) => [...Array(n).keys()].filter(keep);

test('the shader record has room for a list of tileLights, in both lists', () => {
  assert.equal(layout.tileLights, MAX);
  assert.equal(layout.words * 32, layout.threads, 'one mask bit per thread of a batch');
  assert.ok(layout.blendBase - layout.opaqueBase >= MAX, 'opaque list room');
  assert.ok(layout.stride - layout.blendBase >= MAX, 'blend list room');
});

test('0 lights: empty lists', () => {
  const tiles = compactTile(layout, mask([], []), 0);
  assert.deepEqual(tileLists(layout, tiles, MAX), { opaque: [], blend: [] });
});

test('all masks zero, count at the scene lights ceiling', () => {
  const tiles = compactTile(layout, mask([], []), MAX);
  assert.deepEqual(tileLists(layout, tiles, MAX), { opaque: [], blend: [] });
});

test('every declared light touching one tile is kept, in order, none dropped', () => {
  const tiles = compactTile(layout, mask(range(MAX), range(MAX)), MAX);
  assert.deepEqual([tiles[0], tiles[1]], [MAX, MAX]);
  assert.deepEqual(tileLists(layout, tiles, MAX), { opaque: range(MAX), blend: range(MAX) });
});

test('more than 32 lights in one tile: all of them contribute', () => {
  const tiles = compactTile(layout, mask(range(33), range(40)), MAX);
  assert.deepEqual(tileLists(layout, tiles, MAX), { opaque: range(33), blend: range(40) });
});

test('holey mask: every other light retained, including across the 32-bit word boundary', () => {
  const even = range(MAX, (i) => i % 2 === 0);
  const odd = range(MAX, (i) => i % 2 === 1);
  const tiles = compactTile(layout, mask(even, odd), MAX);
  assert.deepEqual(tileLists(layout, tiles, MAX), { opaque: even, blend: odd });
});

test('isolated bit at word boundary (31 and 32)', () => {
  const tiles = compactTile(layout, mask([31, 32], [32]), MAX);
  assert.deepEqual(tileLists(layout, tiles, MAX), { opaque: [31, 32], blend: [32] });
});

test('a light at or beyond the count is never written', () => {
  // The shader's `lane<count` guard keeps such a bit unset; the compaction ignores it anyway.
  const tiles = compactTile(layout, mask([0, 5], [5]), 3);
  assert.equal(tiles[layout.opaqueBase], 0);
  assert.ok(!tiles.includes(5), 'light 5 written');
});

test('300 lights reaching one tile: its count stays true and it walks every light (#822)', () => {
  const blend = range(300, (i) => i % 7 === 0);
  const tiles = compactTile(layout, mask(range(300), blend), 300);
  assert.deepEqual([tiles[0], tiles[1]], [300, blend.length]);
  assert.deepEqual(tileLists(layout, tiles, 300), { opaque: range(300), blend });
});

test('fuzz: random masks and counts, any thread order gives the ascending list', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let trial = 0; trial < 40; trial++) {
    const count = 1 + Math.floor(rand() * 600);
    const opaque = range(count, () => rand() < 0.1);
    const blend = range(count, () => rand() < 0.1);
    const lanes = range(layout.threads);
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
    }
    const inOrder = compactTile(layout, mask(opaque, blend), count);
    const shuffled = compactTile(layout, mask(opaque, blend), count, lanes);
    assert.deepEqual(shuffled, inOrder, `thread order changed the record at trial ${trial}`);
    const walked = (kept: number[]) => (kept.length <= MAX ? kept : range(count));
    assert.deepEqual(tileLists(layout, inOrder, count), {
      opaque: walked(opaque),
      blend: walked(blend),
    });
  }
});

test('the tile shader writes each kept light at its rank, after the batches before it', () => {
  assert.doesNotMatch(LIGHT_TILES_SHADER, /MAX_LIGHTS|MAX_TILE_LIGHTS/, 'no light ceiling');
  // Every light is tested: the batch loop runs to the scene's count, uniform for the workgroup.
  assert.match(LIGHT_TILES_SHADER, /let count=workgroupUniformLoad\(&lightCount\);/);
  assert.match(LIGHT_TILES_SHADER, /for\(var first=0u;first<count;first\+=256u\)\{/);
  for (const [slice, kept] of [
    ['OPAQUE', 'x'],
    ['BLEND', 'y'],
  ])
    assert.match(
      LIGHT_TILES_SHADER,
      new RegExp(
        `if\\(index<count&&maskHolds\\(${slice}_MASK,lane\\)\\)\\{\\n` +
          ` {3}let at=kept\\.${kept}\\+rankBefore\\(${slice}_MASK,lane\\);\\n` +
          ` {3}if\\(at<TILE_LIGHTS\\)\\{tiles\\[base\\+TILE_${slice}_BASE\\+at\\]=index;\\}`,
      ),
    );
  assert.match(
    LIGHT_TILES_SHADER,
    /if\(lane==0u\)\{tiles\[base\]=kept\.x\+maskTotal\(OPAQUE_MASK\);tiles\[base\+1u\]=kept\.y\+maskTotal\(BLEND_MASK\);\}/,
  );
});

test('up to 256 lights, the tile pass waits at the four barriers it always had (#822)', () => {
  // The clear before a later batch and the count after one run only when a batch follows: one
  // batch runs init, depth, bounds and tests, each behind one barrier, as before the batches.
  const body = LIGHT_TILES_SHADER.slice(LIGHT_TILES_SHADER.indexOf('fn lightTiles('));
  const unguarded = body
    .split('\n')
    .filter((line) => !/if\(first>0u\)|if\(first\+256u<count\)/.test(line));
  const waits = unguarded.join('\n').match(/workgroupBarrier\(\)|workgroupUniformLoad\(/g);
  assert.equal(waits?.length, 4);
});
