// The cut no longer visits any cluster flat: level descent dispatches over the queue
// the previous level filled, `dagWanted` over candidate pages only, and the kernels
// that follow over the live-cluster list. This file holds the list each kernel walks;
// `encode.test.ts` holds the number of commands a frame opens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeDagKernels } from './encode.ts';
import { DAG_SELECTION_SHADER } from './selection.ts';
import { encodeurTemoin, ressources, ETAGES, LIVE, CAND } from './encode.fixture.ts';

test('each cut kernel dispatches over the list the previous one filled', () => {
  const { encoder, lancements } = encodeurTemoin();
  encodeDagKernels(encoder as unknown as GPUCommandEncoder, ressources(true));
  const parNoyau = new Map(lancements.map((l) => [l.noyau, l]));
  // Live clusters: the previous verdict, spoken on them alone.
  for (const noyau of ['dagMask', 'dagDrawScatter']) {
    assert.equal(parNoyau.get(noyau)?.groupes, 'indirect', `${noyau} follows a list`);
    assert.equal(parNoyau.get(noyau)?.liste, LIVE, `${noyau} follows the live list`);
  }
  // Candidate pages, and them alone: a page under a rejected node is no longer read.
  assert.equal(parNoyau.get('dagWanted')?.liste, CAND);
  // Descent: pass 0 starts from the roots, from a count known at packing, and each
  // following level from its level's node count — known at packing too. No
  // indirection, hence no argument recopy, and no level visits the whole hierarchy.
  assert.deepEqual(lancements.slice(2, 5), [
    { noyau: 'dagLevel0', groupes: 1 },
    { noyau: 'dagLevel1', groupes: Math.ceil(ETAGES[1] / 64) },
    { noyau: 'dagLevel2', groupes: Math.ceil(ETAGES[2] / 64) },
  ]);
  const ordre = lancements.map((l) => l.noyau);
  assert.ok(ordre.indexOf('dagWanted') > ordre.lastIndexOf('dagLevel2'));
  assert.ok(ordre.indexOf('dagMask') > ordre.indexOf('dagWanted'));
  // The count launched flat is that of primitives, blocks, a hierarchy level or one workgroup:
  // never that of clusters.
  const plats = lancements.filter((l) => l.groupes !== 'indirect').map((l) => l.noyau);
  assert.deepEqual(plats, [
    'dagPrepare',
    'dagLevel0',
    'dagLevel1',
    'dagLevel2',
    'dagDrawPrefix',
    'dagSortRequests',
  ]);
});

test('wait between launches depends only on depth, not on cluster count', () => {
  const { encoder, lancements } = encodeurTemoin();
  encodeDagKernels(encoder as unknown as GPUCommandEncoder, ressources(true));
  // Log clear, prepare, one pass per level (three), candidates, mask, prefix, compaction and the
  // request sort: the cut rule decides each cluster once, in the mask, with no round per
  // primitive before it.
  assert.equal(lancements.length, 10);
  const noyaux = lancements.map((l) => l.noyau);
  assert.ok(!noyaux.includes('dagArgs') && !noyaux.includes('dagDrawCount'));
  assert.equal(noyaux[0], 'dagClearDrawn');
  assert.equal(noyaux[1], 'dagPrepare');
  // Prepare covers both the primitives and the compaction blocks.
  assert.equal(lancements[1].groupes, 1);
  // Sixteen times more clusters, as many launches: depth is what counts them.
  const large = encodeurTemoin();
  encodeDagKernels(large.encoder as unknown as GPUCommandEncoder, ressources(true, 3, 65536));
  assert.equal(large.lancements.length, lancements.length);
  // One more level, one more launch.
  const profond = encodeurTemoin();
  encodeDagKernels(profond.encoder as unknown as GPUCommandEncoder, ressources(true, 4));
  assert.equal(profond.lancements.length, lancements.length + 1);
});

test('without a resident cut, the mask follows the list and nothing is compacted', () => {
  const { encoder, lancements } = encodeurTemoin();
  encodeDagKernels(encoder as unknown as GPUCommandEncoder, ressources(false));
  const noyaux = lancements.map((l) => l.noyau);
  assert.ok(!noyaux.includes('dagDrawPrefix') && !noyaux.includes('dagDrawScatter'));
  const masque = lancements.find((l) => l.noyau === 'dagMask');
  assert.equal(masque?.groupes, 'indirect');
  assert.equal(masque?.liste, LIVE);
  // Descent itself is encoded in both cases: it does not depend on residency.
  assert.ok(noyaux.includes('dagLevel0') && noyaux.includes('dagLevel1'));
  assert.ok(noyaux.includes('dagLevel2'));
});

test('list kernels read their cluster from the list, not from their thread id', () => {
  // The rejection these kernels used to do themselves — `visible` — has left their body: a cluster
  // missing from the list is exactly a cluster whose `visible` was false.
  for (const noyau of ['dagMask']) {
    const corps = DAG_SELECTION_SHADER.split(`fn ${noyau}(`)[1].split('\n}')[0];
    assert.match(corps, /=liveAt\(s\);/, `${noyau} reads the list`);
    assert.doesNotMatch(corps, /visible\(/, `${noyau} does not redo the rejection`);
  }
});
