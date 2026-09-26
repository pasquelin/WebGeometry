// The dispatch bench compares the frozen descent with the shipped one inside ONE module: every
// stage around the descent is the shipped one. A shipped stage that calls a function the frozen
// text owns reads the FROZEN layout there, and the two cuts stop comparing like with like without
// a compile error: #477 made `dagMask` stamp each page's last use at `queueBase(3u)`, the frozen
// `queueBase` answered zero for it, and the stamps overwrote the draw flags — "same drawn pages"
// failed in the browser only. The call sites are pinned here, in Node, so a new one is seen first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DESCENT_AVANT } from './cut-dispatches-wgsl.ts';
import { DAG_SELECTION_SHADER } from '../../../packages/sdk-browser/src/gpu/dag/shader/shader.ts';
import { DAG_LEVEL_WGSL } from '../../../packages/sdk-browser/src/gpu/dag/shader/levelWgsl.ts';

test('the shipped stages reach the frozen descent only through the calls it answers as they do', () => {
  const frozen = [...DESCENT_AVANT.matchAll(/\bfn (\w+)\(/g)].map((m) => m[1]);
  const stages = DAG_SELECTION_SHADER.replace(DAG_LEVEL_WGSL, '').replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    '',
  );
  const calls = stages.matchAll(
    new RegExp(`\\b(?:${frozen.join('|')})\\((?:[^()]|\\([^()]*\\))*\\)`, 'g'),
  );
  // Each is the frozen layout's own business: `resetCounters` zeroes its counters, `drawnAppend`
  // logs a drawn page where its `dagClearDrawn` reads it, and `dagWanted` bounds its dispatch by
  // its candidate count. A call added here reads the frozen layout: take the callee from the
  // shipped descent (`AVANT_SHIMS`) unless both layouts give it the same answer.
  assert.deepEqual([...new Set([...calls].map((m) => m[0]))].sort(), [
    'candCounter()',
    'drawnAppend(i)',
    'resetCounters()',
  ]);
});
