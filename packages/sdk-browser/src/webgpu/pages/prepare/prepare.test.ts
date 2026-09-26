// Lot F, F18: three calculations of a WebGPU engine prepare. `indexSourceBytes` and
// `compteMateriauxEtTangentes` (../io/catalogue.ts) replace a `flatMap` of a pair per page and
// a `map`/two table copies with one walk each; their oracles are the implementations from before
// lot F. `prepareCones` no longer computes a cone: it posts the one the compiler cooked (#272).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../../host/graph/graph.fixture.ts';
import { OPEN_CONE, type NormalCone } from '../../../page/cone/cone.ts';
import { surfaceOf } from '../../../page/surface.ts';
import { prepareCones } from './cones.ts';
import { indexSourceBytes, compteMateriauxEtTangentes } from '../io/catalogue.ts';
import {
  referenceIndexSourceBytes,
  referenceCompteMateriauxEtTangentes,
} from '../../../../../../bench/oracles/browser/normal-cones.ts';
import type { PageRec } from '../../../page/selection/selection.ts';
import type { WebgpuPagesRuntime } from '../runtime.ts';

const COOKED: NormalCone = { axis: [0, 0, 1], angle: 0.25 };

/** A one-triangle cluster wearing `material`, with its cooked cone and no host vertices at all:
 *  a `prepareCones` that still read positions would find none. */
function triangle(material: G.GraphSurface) {
  return {
    array: Uint32Array.of(0, 1, 2),
    attributes: {},
    material: surfaceOf(material),
    cone: COOKED,
  } as unknown as PageRec;
}
/** What `prepareCones` reads of a runtime: its roots, each with its pages. */
function runtime(pages: PageRec[], roots = [{ cones: false, pages }]) {
  return { setup: { roots } } as unknown as WebgpuPagesRuntime;
}

test('a one-sided cluster is given the cone the compiler cooked, read from no vertex', () => {
  const page = triangle(G.basicSurface({ side: G.FRONT_SIDE }));
  prepareCones(runtime([page]));
  assert.equal(page.cone, COOKED);
});

test('a double-sided or back-facing material keeps its cone open', () => {
  const pages = [
    triangle(G.basicSurface({ side: G.DOUBLE_SIDE })),
    triangle(G.basicSurface({ side: G.BACK_SIDE })),
  ];
  prepareCones(runtime(pages));
  assert.deepEqual(
    pages.map((page) => page.cone),
    [OPEN_CONE, OPEN_CONE],
  );
});

test('indexSourceBytes yields the same table as the reference flatMap, last page of a winning address', () => {
  const a = { url: 'p/0', array: Uint32Array.of(1, 2, 3) } as unknown as PageRec;
  const b = { url: 'p/1', array: undefined } as unknown as PageRec; // no bytes: absent from both
  const c = { url: 'p/0', array: Uint32Array.of(9, 9) } as unknown as PageRec; // same address as a
  const pages = [a, b, c];
  const obtenu = indexSourceBytes(pages);
  const attendu = referenceIndexSourceBytes(pages);
  assert.deepEqual([...obtenu.keys()], [...attendu.keys()]);
  for (const [url, bytes] of obtenu)
    assert.deepEqual(Array.from(bytes), Array.from(attendu.get(url) ?? new Uint8Array(0)));
});

test('indexSourceBytes on an empty catalogue yields an empty table', () => {
  assert.deepEqual(indexSourceBytes([]), referenceIndexSourceBytes([]));
});

test('compteMateriauxEtTangentes counts distinct materials and geometries with/without tangents', () => {
  const materialA = G.basicSurface(),
    materialB = G.basicSurface();
  const pages = [
    { material: materialA } as unknown as PageRec,
    { material: materialA } as unknown as PageRec, // same material, does not recount
    { material: materialB } as unknown as PageRec,
  ];
  const geometryBlocks = new Map<unknown, { hasTangent: boolean }>([
    ['g0', { hasTangent: true }],
    ['g1', { hasTangent: false }],
    ['g2', { hasTangent: true }],
  ]);
  assert.deepEqual(
    compteMateriauxEtTangentes(pages, geometryBlocks),
    referenceCompteMateriauxEtTangentes(pages, geometryBlocks),
  );
});

test('compteMateriauxEtTangentes on an empty catalogue and geometry table yields zeros', () => {
  assert.deepEqual(
    compteMateriauxEtTangentes([], new Map()),
    referenceCompteMateriauxEtTangentes([], new Map()),
  );
});

test('posting a cone declares its root; a root whose pages carry no cone stays declared bare', () => {
  // `collectClusterPages` declares `cones: false`; without this sample, the cut would no longer read
  // the cone this prepare just wrote, and cone culling would vanish without a sound.
  const porte = triangle(G.basicSurface());
  const nue = { ...triangle(G.basicSurface()), cone: undefined } as unknown as PageRec;
  const roots = [
    { cones: false, pages: [porte] },
    { cones: false, pages: [nue] },
  ];
  prepareCones(runtime([], roots));
  assert.equal(roots[0].cones, true);
  assert.equal(roots[1].cones, false);
});

test('a cooked cluster whose indices are not held posts its cone all the same (#828)', () => {
  // A streamed cluster, or an opaque one drawn from its geometry page, holds no index array at
  // prepare time: its cone is the compiler's, read from no index, and the cut culls it.
  const streamed = { ...triangle(G.basicSurface()), array: undefined } as unknown as PageRec;
  const roots = [{ cones: false, pages: [streamed] }];
  prepareCones(runtime([], roots));
  assert.equal(streamed.cone, COOKED);
  assert.equal(roots[0].cones, true);
});
