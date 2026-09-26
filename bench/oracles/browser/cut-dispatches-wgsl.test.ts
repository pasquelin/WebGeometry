// The frozen descent runs inside the shipped shader: a shipped stage calling a function the frozen
// text owns reads the FROZEN layout, silently. #477: `stampUse` wrote at the frozen `queueBase(3u)`,
// zero, over the draw flags, and "same drawn pages" failed in the browser only. Pinned here, in Node.
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
  // Every call site, not each distinct text: a second `candCounter()` elsewhere is a new reader too.
  assert.deepEqual([...calls].map((m) => m[0]).sort(), [
    'candCounter()',
    'drawnAppend(i)',
    'resetCounters()',
  ]);
});
