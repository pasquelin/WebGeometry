// BROADCAST request: the page and its priority in a word, and the order that priority gives.
//
// The WebGL2 path has always sorted its requests by the SUBSTITUTE's screen error — a missing
// cluster is drawn by a coarser ancestor, and that ancestor's error is what the eye sees
// (`../../streaming/priority.ts`, `orderPendingUrls`). The WebGPU path published them in the order of
// an atomic counter, i.e. in none. This test holds both halves:
// ① the word yields exactly what was put in it, and quantification never reverses two errors;
// ② the order the cut publishes is that of the WebGL2 formula, on the same scene.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  packRequest,
  quantizeRequestPriority,
  REQUEST_PAGE_MAX,
  REQUEST_PRIORITY_MAX,
  REQUEST_PRIORITY_SCALE,
  REQUEST_STEP_MAX,
  requestPage,
  requestRank,
  requestPriority,
} from './request.ts';
import { evaluateDagSelectionKernel } from './selection.ts';
import { requestScene } from './requestScene.fixture.ts';
import {
  clusterErrorPixels,
  maxStretch,
  multiplyMatrix4,
  transformAffinePoint,
} from '../../../../sdk-core/src/index.ts';

test('the request word yields the page and the priority that were put in it', () => {
  for (const page of [0, 1, 4095, 1959791, REQUEST_PAGE_MAX - 1])
    for (const priority of [0, 1, 512, REQUEST_PRIORITY_MAX]) {
      const mot = packRequest(page, priority);
      assert.equal(requestPage(mot), page, `page ${page} / priority ${priority}`);
      assert.equal(requestPriority(mot), priority, `page ${page} / priority ${priority}`);
    }
});

test('quantification is monotone: it never reverses two errors', () => {
  const erreurs = [0, 0.001, 0.01, 0.1, 0.5, 1, 2, 4, 16, 64, 256, 4096, 65536, Infinity];
  let precedent = -1;
  for (const pixels of erreurs) {
    const q = quantizeRequestPriority(pixels);
    assert.ok(q >= precedent, `${pixels} px : ${q} < ${precedent}`);
    assert.ok(q >= 0 && q <= REQUEST_PRIORITY_MAX, `${pixels} px hors bornes : ${q}`);
    precedent = q;
  }
  // A null or absurd error never goes ahead of a real error.
  assert.equal(quantizeRequestPriority(0), 0);
  assert.equal(quantizeRequestPriority(-1), 0);
  assert.equal(quantizeRequestPriority(NaN), 0);
  assert.equal(quantizeRequestPriority(Infinity), REQUEST_STEP_MAX);
});

test('every visible request outranks every request ahead of the camera', () => {
  // The costliest absence ahead against the cheapest one on screen: the deadline decides first.
  const rank = (pixels: number, ahead = false) =>
    requestRank(quantizeRequestPriority(pixels, ahead));
  assert.ok(rank(0) > rank(Infinity, true));
  assert.equal(rank(NaN, true), 0, 'the least a request can rank');
  assert.equal(rank(Infinity), REQUEST_PRIORITY_MAX, 'the most a request can rank');
  // Within the tier ahead, the same monotone ranking by error.
  assert.ok(rank(64, true) > rank(4, true));
});

function coupe(seuil: number) {
  const scene = requestScene(seuil);
  return { ...scene, releve: evaluateDagSelectionKernel(scene.packed, scene.uni) };
}

test('published order decreases with the substitute’s screen error, like the WebGL2 path', () => {
  const { pages, packed, cam, uni, releve } = coupe(1);
  assert.ok(releve.pageIds.length > 100, 'the cut must keep enough to rank');
  const focal = Math.max(uni.pixelScale[0], uni.pixelScale[1]);
  // View of each pose, composed as the kernel composes it: on matrices BROUGHT TO THE RENDER
  // FRAME, those `packedWorldsToRenderOrigin` wrote into `packed.worlds`. Taking the roots'
  // would mix an absolute world with a relative view, and put the whole scene on the eye — which
  // would yield an infinite error for half the cut, in silence.
  const vues = Array.from({ length: packed.worldCount }, (_, w) => {
    const vue = new Float64Array(16);
    multiplyMatrix4(
      vue,
      cam.viewRelative,
      Float64Array.from(packed.worlds.subarray(w * 16, w * 16 + 16)),
    );
    return { vue, stretch: maxStretch(vue as unknown as readonly number[]) };
  });
  // SUBSTITUTE screen error, by the core formula — the one `orderPendingUrls` uses, and of which
  // `projected` (WGSL) is the proven mirror. Recomputing it here, not rereading it from the
  // snapshot, is what makes the proof non-circular.
  const centre = new Float64Array(4);
  const pixelsDe = (id: number) => {
    const page = pages[id % pages.length],
      { vue, stretch } = vues[Math.floor(id / pages.length)];
    const sphere = (page.parentError === null ? page.sphere : page.parentSphere) as number[];
    const bande = page.parentError === null ? (page.lodError ?? 0) : page.parentError;
    transformAffinePoint(centre, vue, sphere[0], sphere[1], sphere[2]);
    return clusterErrorPixels(
      bande,
      stretch,
      centre[0],
      centre[1],
      centre[2],
      sphere[3],
      focal,
      cam.near,
    );
  };
  const pixels = releve.pageIds.map(pixelsDe);
  assert.ok(new Set(pixels.map((p) => p.toFixed(3))).size > 8, 'the cut must carry varied errors');
  // Published order never rises beyond ONE quantification STEP. Two reasons, and not one more:
  // between two clusters of the same step order is indifferent — the reference does not break
  // those ties either —, and the boundary between two steps is floating, the kernel rounding in
  // f32 what this proof recomputes in f64. One step is 2^(1/16), i.e. 4.43 %.
  const PAS = 2 ** (1 / REQUEST_PRIORITY_SCALE);
  for (let i = 1; i < pixels.length; i++)
    assert.ok(
      pixels[i] <= pixels[i - 1] * PAS,
      `rank ${i}: ${pixels[i]} px steps more than one step past ${pixels[i - 1]} px`,
    );
  // And the first is indeed the most costly absence of the whole cut, to the step.
  assert.ok(pixels[0] * PAS >= Math.max(...pixels), 'the head is not the most expensive');
});
