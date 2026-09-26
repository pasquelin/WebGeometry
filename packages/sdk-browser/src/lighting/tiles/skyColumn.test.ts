import test from 'node:test';
import assert from 'node:assert/strict';
import {
  invertMatrix4,
  multiplyMatrix4,
  perspectiveProjection,
} from '../../../../sdk-core/src/index.ts';
import { LIGHT_TILES_SHADER } from './shader.ts';
import {
  compactTile,
  tileLayout,
  tileLists,
} from '../../../../../bench/oracles/browser/gpuLightTilesRankOracle.ts';
import {
  sphereTouchesColumn,
  tileColumn,
  tileCorner,
  type TileView,
} from '../../../../../bench/oracles/browser/gpuLightTileColumnOracle.ts';

// Issue #28: a blend surface in front of the sky may stand at any distance, so a tile with a
// sky pixel gives its blend list the tile's whole column — never a box that stops at the
// farthest opaque, and never the whole world either.

const width = 1920,
  height = 1080;
function view(eye: [number, number, number]): TileView {
  const projection = perspectiveProjection(new Float64Array(16), 60, width / height, 0.1, 1);
  const translate = new Float64Array([
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    -eye[0],
    -eye[1],
    -eye[2],
    1,
  ]);
  const viewProjection = multiplyMatrix4(new Float64Array(16), projection, translate);
  return {
    inverseViewProjection: invertMatrix4(new Float64Array(16), viewProjection),
    width,
    height,
  };
}
const tile: [number, number] = [37, 21];
/** A point on the axis of the tile's column, `near / depth` metres away from the eye. */
function onAxis(v: TileView, depth: number) {
  const corners = [0, 1, 2, 3].map((c) => tileCorner(v, tile, c, depth));
  return [0, 1, 2].map((a) => corners.reduce((s, p) => s + p[a] / 4, 0)) as [
    number,
    number,
    number,
  ];
}

for (const eye of [
  [0, 0, 0],
  [5000, 20, -3000],
] as [number, number, number][]) {
  test(`sky column at eye ${eye}: keeps a light at any distance in the tile, rejects the others`, () => {
    const v = view(eye);
    const column = tileColumn(v, tile);
    // A small light a kilometre away, in front of the sky: a far glass pane is lit by it.
    const far = onAxis(v, 0.1 / 1000);
    assert.ok(sphereTouchesColumn(column, far, 0.5));
    // The same light mirrored behind the eye, or moved far across the screen: out.
    const behind = far.map((p, a) => 2 * eye[a] - p) as [number, number, number];
    assert.ok(!sphereTouchesColumn(column, behind, 0.5));
    const across = [far[0] + 400, far[1], far[2]] as [number, number, number];
    assert.ok(!sphereTouchesColumn(column, across, 0.5));
    // Out of the column by its centre, into it by its range: kept, no light is lost.
    assert.ok(sphereTouchesColumn(column, across, 401));
  });
}

test('a tile with a sky pixel lights its blend list from the column, whatever opaque it holds', () => {
  assert.match(LIGHT_TILES_SHADER, /atomicStore\(&skyward,1u\);/);
  assert.match(
    LIGHT_TILES_SHADER,
    /if\(atomicLoad\(&skyward\)==1u\)\{tileColumn\(tile\.xy\);\}else\{blendBox=tileBox\(tile\.xy,1\.0,back\);\}/,
  );
  assert.match(LIGHT_TILES_SHADER, /blendTouched=sphereTouchesColumn\(centre,radius\);/);
  assert.doesNotMatch(LIGHT_TILES_SHADER, /1\.0e30/, 'never the whole world');
});

test('300 lamps before a sky tile: its blend list is their CPU culling, none dropped (#822)', () => {
  const v = view([0, 0, 0]),
    column = tileColumn(v, tile);
  // A lamp every metre down the tile's axis, five in six pushed sideways out of its column.
  const lamps = [...Array(300).keys()].map((i) => {
    const centre = onAxis(v, 0.1 / (1 + i));
    centre[0] += Math.min(1, i % 6) * 0.1 * (1 + i);
    return { centre, radius: 0.002 * (1 + i) };
  });
  const blend = [...lamps.keys()].filter((i) =>
    sphereTouchesColumn(column, lamps[i].centre, lamps[i].radius),
  );
  assert.ok(blend.length <= 64 && blend.some((i) => i >= 256), 'a list, kept past a batch');
  const layout = tileLayout(LIGHT_TILES_SHADER);
  const record = compactTile(layout, { opaque: [], blend }, 300);
  assert.deepEqual(tileLists(layout, record, 300), { opaque: [], blend });
});
