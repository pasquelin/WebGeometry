// CPU/GPU consistency of TOP-DOWN PRUNING: the subtree error floor, stored in the
// node by `packCullingNodes` and projected by `errorFloor` in WGSL, must not drop any
// cluster the cut would have taken.
//
// The bound is a lower bound of the projected error of the whole subtree: above the
// threshold, no cluster is fine enough. An OVERESTIMATED lower bound silently drops
// geometry. The CPU mirror (`errorFloorAt`) works in f64 on the packed values, the
// kernel in f32: that is the gap this bench measures, on the GPU, not on a double.
//
// Three cuts compared, on an eight-LOD pyramid and four poses: the CPU cut
// (`selectVisiblePages`), the kernel's Node oracle, and the WGSL kernel run in Chromium.
// The pruned-subtree count is published: without pruning, the proof would cover nothing.
//
// node --experimental-strip-types tests/browser/probes/error-floor-cpu-gpu.ts
import assert from 'node:assert/strict';
import * as G from '../../../packages/sdk-browser/src/host/graph/graph.fixture.ts';
import { selectVisiblePages } from '../../../packages/sdk-browser/src/page/cut/cut.ts';
import { cullingBounds } from '../../../packages/sdk-browser/src/page/cut/bounds.ts';
import { cameraSelectionUniforms } from '../../../packages/sdk-browser/src/gpu/core/selection.ts';
import {
  evaluateDagSelectionKernel,
  packDagSelection,
  packedWorldsToRenderOrigin,
} from '../../../packages/sdk-browser/src/gpu/dag/selection.ts';
import { descenteComptee } from '../../../packages/sdk-browser/src/gpu/dag/cutFrontier.fixture.ts';
import {
  scenePages,
  sceneRoots,
} from '../../../packages/sdk-browser/src/gpu/dag/cutFrontierScene.fixture.ts';
import { requestPriority } from '../../../packages/sdk-browser/src/gpu/dag/request.ts';
import { selectionGpu } from './selectionKernelGpu.ts';
import { cameraMoteur } from '../../../packages/sdk-browser/src/camera/camera.fixture.ts';
import type { PackedDag } from '../../../packages/sdk-browser/src/gpu/dag/types.ts';
import type { SelectionUniforms } from '../../../packages/sdk-browser/src/gpu/core/selection.ts';

const VIEWPORT: [number, number] = [1280, 720];
/** Fourth field is the threshold; fifth, the depths at which the pyramid is PLACED. A
 *  single depth keeps only one LOD, hence one error band and one priority: priority
 *  equality would then be checked on a constant sequence. Far apart, the copies resolve
 *  to different LODs, as in a real scene. */
const POSES: Array<[string, number, number, number, number[]]> = [
  ['head-on, 1 px', 0, 16, 1, [0]],
  ['head-on, 4 px', 0, 16, 4, [0]],
  ['oblique, 1 px', 9, 14, 1, [0]],
  ['from afar, 0.25 px', 0, 60, 0.25, [0]],
  ['four depths, 1 px', 0, 16, 1, [0, 12, 30, 70]],
];
const pages = scenePages(4096, 8);
const camera = G.perspectiveCamera(55, VIEWPORT[0] / VIEWPORT[1], 0.1, 200);

const cas: Array<{
  nom: string;
  packed: PackedDag;
  uniforms: SelectionUniforms;
  seuil: number;
  cpu: number;
  elagages: number;
  oracle: ReturnType<typeof evaluateDagSelectionKernel>;
}> = [];
for (const [nom, x, z, seuil, profondeurs] of POSES) {
  const mondes = profondeurs.map((p) => new G.Matrix4().makeTranslation(0, 0, -p));
  const roots = sceneRoots(pages, mondes);
  camera.position.set(x, 0, z);
  camera.lookAt(x, 0, 0);
  camera.updateMatrixWorld(true);
  const uniforms = cameraSelectionUniforms(cameraMoteur(camera), seuil, VIEWPORT);
  // The kernel works in the render frame: packed world matrices are brought there, as the
  // engine carries them, otherwise relative view and absolute world would mix.
  const packed = packedWorldsToRenderOrigin(packDagSelection(roots), roots, uniforms.cameraWorld);
  // The CPU cut takes the same nodes with its own bounds, in f64: that is the reference. Every
  // root `sceneRoots` builds carries `culling`: the fixture never omits it.
  const rootCulling = roots[0].culling;
  assert.ok(rootCulling, 'the scene root carries no culling nodes');
  const bornes = cullingBounds(rootCulling, pages);
  const cpu = selectVisiblePages(
    mondes.map((monde) => ({
      world: monde,
      pages,
      cones: false,
      culling: { ...rootCulling, bounds: bornes },
    })),
    cameraMoteur(camera),
    { pixelError: seuil, viewport: VIEWPORT },
  );
  cas.push({
    nom,
    packed,
    uniforms,
    seuil,
    cpu: cpu.shown.length,
    elagages: descenteComptee(packed, uniforms, true).plancherCoupe,
    oracle: evaluateDagSelectionKernel(packed, uniforms),
  });
}

const gpu = await selectionGpu(
  cas.map(({ nom, packed, uniforms }) => ({ name: nom, packed, uniforms })),
);
assert.equal(gpu.indisponible ?? null, null);
assert.deepEqual([...(gpu.compilation ?? []), ...(gpu.erreurs ?? [])], []);
assert.ok(gpu.resultats, 'no result');
const resultats = gpu.resultats;
const lignes = cas.map((c) => {
  const lu = resultats.find((r) => r.name === c.nom);
  return {
    pose: c.nom,
    seuil: c.seuil,
    sousArbresElagues: c.elagages,
    retenuesCpu: c.cpu,
    retenuesOracle: c.oracle.pageIds.length,
    retenuesGpu: lu?.pages.length ?? null,
    ecartOracleGpu: lu ? Math.abs(lu.pages.length - c.oracle.pageIds.length) : null,
    // Triangle totals the GPU holds, against those the oracle replays at the same place.
    trianglesOracle: c.oracle.selectedTriangles,
    trianglesGpu: lu?.selectedTriangles ?? null,
    // The ORDER the GPU publishes, against the oracle's: each request's priority decides
    // who the host uploads first, and an order that was not that one would serve nothing.
    // Compared on the priority sequence, not the pages: two pages of the same step are
    // interchangeable on both sides, and the step is what ranking reads.
    // The GPU sorts its requests itself (`dagSortRequests`) and the host reads them as they
    // come: the PRIORITY SEQUENCE is compared as the GPU wrote it.
    prioritesGpu: lu ? lu.demandes.map(requestPriority) : null,
    prioritesOracle: c.oracle.requestPriorities,
  };
});
// Priority sequences run to thousands of entries: published as a summary, compared in full.
const resume = (suite: number[] | null) =>
  suite && { pas: new Set(suite).size, haute: suite[0], basse: suite[suite.length - 1] };
console.log(
  JSON.stringify(
    {
      pages: pages.length,
      adaptateur: gpu.adaptateur,
      lignes: lignes.map(({ prioritesGpu, prioritesOracle, ...reste }) => ({
        ...reste,
        prioritesGpu: resume(prioritesGpu),
        memesPriorites: JSON.stringify(prioritesGpu) === JSON.stringify(prioritesOracle),
      })),
    },
    null,
    2,
  ),
);
// At least one pose must carry SEVERAL priority steps: on a constant sequence, priority
// equality would say nothing, and the bench would go green without proving anything more.
assert.ok(
  lignes.some((ligne) => new Set(ligne.prioritesGpu).size > 1),
  'no pose carries more than one priority step',
);
for (const ligne of lignes) {
  assert.ok(ligne.sousArbresElagues > 0, `${ligne.pose}: no subtree pruned`);
  assert.equal(ligne.ecartOracleGpu, 0, `${ligne.pose}: GPU and oracle diverge`);
  assert.equal(ligne.retenuesGpu, ligne.retenuesCpu, `${ligne.pose}: GPU loses from the cut`);
  assert.ok(ligne.trianglesGpu !== null, `${ligne.pose}: no GPU result`);
  assert.ok(ligne.trianglesGpu > 0, `${ligne.pose}: no triangle counted`);
  assert.equal(
    ligne.trianglesGpu,
    ligne.trianglesOracle,
    `${ligne.pose}: GPU and oracle totals diverge`,
  );
  // Each request's priority decides who the host uploads first: GPU and oracle must give
  // the same sequence, otherwise the shipped order would not be the one that was proved.
  assert.deepEqual(
    ligne.prioritesGpu,
    ligne.prioritesOracle,
    `${ligne.pose}: GPU and oracle do not give the same priorities`,
  );
}
