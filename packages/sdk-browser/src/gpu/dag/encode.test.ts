// Cut encoding contract: the NUMBER of commands a frame opens, sole cause of the wait timestamps
// attribute to no kernel. It depends NEITHER on hierarchy depth NOR on cluster count: six, always.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeDagKernels } from './encode.ts';
import { encodeurTemoin, ressources, LIVE, CAND, DRAWN } from './encode.fixture.ts';

test('a frame opens only six commands, whatever the depth', () => {
  // What the GPU pays between two kernels is counted in COMMANDS, not threads: each compute pass
  // and each copy outside a pass closes the current encoder and opens another. There used to be
  // 3·depth+3 — 42 on the bench's depth-thirteen hierarchy — because each level dispatched
  // indirectly and therefore had to arm its argument. Descent now dispatches flat, in the head
  // pass: three arming copies and three passes, period.
  for (const levelCount of [1, 3, 5]) {
    const { encoder, copies, passes } = encodeurTemoin();
    encodeDagKernels(encoder as unknown as GPUCommandEncoder, ressources(true, levelCount));
    assert.equal(passes.length, 3, 'head, candidates, live');
    assert.equal(copies.length, 3, 'one arming per list whose layout knows no bound');
    assert.equal(passes.length + copies.length, 6);
  }
});

test('the dispatch argument is copied outside a pass, between two cut passes', () => {
  const { encoder, copies, passes } = encodeurTemoin();
  encodeDagKernels(encoder as unknown as GPUCommandEncoder, ressources(true));
  // WebGPU refuses `work` both written and as an argument in the same scope: each arming
  // therefore cuts the pass, and carries only the head word, the other two being one since
  // creation. Only three remain, for the three lists whose layout knows no upper bound: the
  // previous frame's drawn journal, the candidates and the live ones.
  assert.deepEqual(copies, [
    { de: 'work', decalage: DRAWN, vers: 'dispatchArgs', octets: 4, enPasse: false },
    { de: 'work', decalage: CAND, vers: 'dispatchArgs', octets: 4, enPasse: false },
    { de: 'work', decalage: LIVE, vers: 'dispatchArgs', octets: 4, enPasse: false },
  ]);
  assert.deepEqual(passes, new Array(3).fill('Trillion3D DAG selection'));
});

test('every light view of a frame shares one traversal: the same commands as one view', () => {
  // Three views as three runs paid three times the waits between dispatches; one run over the
  // three pays them once. Each level still dispatches the threads its bound allows per view, and
  // never more than its queue holds.
  const views = 3,
    queueCap = 1000;
  const light = { ...ressources(true, 5), light: { views, queueCap } };
  const { encoder, copies, passes, lancements } = encodeurTemoin();
  encodeDagKernels(encoder as unknown as GPUCommandEncoder, light);
  assert.equal(passes.length + copies.length, 5, 'no clear of draw flags a light never sets');
  const flat = (noyau: string) => lancements.filter((l) => l.noyau === noyau).map((l) => l.groupes);
  assert.deepEqual(flat('dagPrepare'), [1], 'one thread per slot: two primitives × three views');
  assert.deepEqual(
    [...flat('dagLevel0'), ...flat('dagLevel1'), ...flat('dagLevel2')].sort(),
    [1, 1, 2, 8, 16].sort(),
    'stages [2, 9, 40, 150, 600] per view, three views, capped at 1000 queued nodes',
  );
  const noyaux = lancements.map((l) => l.noyau);
  assert.ok(!noyaux.includes('dagClearDrawn') && !noyaux.includes('dagDrawPrefix'));
  assert.ok(!noyaux.includes('dagSortRequests'), 'a light cut sorts its requests on the host');
  assert.ok(noyaux.indexOf('dagViewOffsets') < noyaux.indexOf('dagMask'));
});

test('the camera cut sorts its requests once, last, in one workgroup of the live pass', () => {
  for (const residentCut of [true, false]) {
    const { encoder, lancements } = encodeurTemoin();
    encodeDagKernels(encoder as unknown as GPUCommandEncoder, ressources(residentCut));
    assert.deepEqual(lancements.at(-1), { noyau: 'dagSortRequests', groupes: 1 });
    assert.equal(lancements.filter((l) => l.noyau === 'dagSortRequests').length, 1);
  }
});
