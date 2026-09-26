import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { failures } from './failure.ts';
import { flagged, healthCheck, UNTIL, type Counters as Metrics } from './verdict.ts';

/** Draws `count` frames of `part`, `gap` ms apart, each with `metrics(k)`, and returns the
 *  verdict's lines as name → [green, motif]. */
function judged(
  frames: [part: string, count: number, gap: number, metrics: (k: number) => Metrics][],
  refused: [reason: string, documented?: boolean][] = [],
) {
  let now = 0,
    part: string | null = null;
  const hooks: ((frame: { metrics: Metrics }) => void)[] = [];
  mock.method(performance, 'now', () => now);
  failures.clear();
  const world = { onFrame: (hook: never) => (hooks.push(hook), () => {}), renderer: 'webgl2' };
  const check = healthCheck(world, () => part);
  for (const [name, count, gap, metrics] of frames) {
    part = name;
    for (let k = 0; k < count; k++, now += gap)
      hooks.forEach((hook) => hook({ metrics: metrics(k) }));
  }
  for (const [reason, documented] of refused) check.refuse(reason, documented);
  mock.restoreAll();
  const verdict = check.verdict();
  return {
    correct: verdict.correct,
    lines: Object.fromEntries(
      verdict.resultats.map((line) => [line.name, [line.correct, line.motif]]),
    ),
  };
}

const healthy = () => ({
  gpuFrameMs: 6,
  gpuShadowsMs: 1.5,
  shadowPagesDrawn: 3,
  shadowPagesRefetched: 40,
});

test('a part drawn at 120 Hz within its budgets is green on every line, part by part', () => {
  const { correct, lines } = judged([
    ['close', 121, 1000 / 120, healthy],
    ['far', 61, 1000 / 120, healthy],
  ]);
  assert.equal(correct, true);
  assert.deepEqual(lines['close: FPS'], [true, '120 ≥ 60, mean 120']);
  assert.deepEqual(lines['far: GPU frame'], [true, '6.00 ms ≤ 16.67 ms']);
  assert.deepEqual(lines['far: GPU shadows'], [true, '1.50 ms ≤ 2.00 ms, until #525']);
  assert.deepEqual(lines['far: shadow pages drawn'], [null, '3']);
  assert.deepEqual(lines['close: shadow pages refetched'], [null, '0']);
  assert.deepEqual(lines.refused, [true, '—']);
});

test('a budget the engine does not meet yet names its issue, shows red and counts against no verdict', () => {
  assert.ok(Object.values(UNTIL).every(Number.isInteger));
  const { correct, lines } = judged([['pan', 11, 10, () => ({ ...healthy(), gpuShadowsMs: 30 })]]);
  assert.deepEqual(lines['pan: GPU shadows'], [false, '30.00 ms ≤ 2.00 ms, until #525']);
  assert.equal(correct, true);
  assert.ok(flagged({ motif: ', until #525' } as never) && !flagged({ motif: '3' } as never));
});

test('a part at 60 Hz with a few late frames stays green; a slowed build is red, the verdict too', () => {
  const late = judged([
    ['close', 50, 1000 / 60, healthy],
    ['close', 5, 25, healthy],
  ]);
  assert.deepEqual(late.lines['close: FPS'], [true, '60 ≥ 60, mean 58']);
  const { correct, lines } = judged([['still', 31, 1000 / 30, healthy]]);
  assert.equal(correct, false);
  assert.deepEqual(lines['still: FPS'], [false, '30 ≥ 60, mean 30']);
  assert.equal(lines['still: GPU frame'][0], true);
});

test('a counter over its budget turns its line red; a reading or one not measured is neither', () => {
  const { lines } = judged([
    [
      'pan',
      11,
      10,
      (k) => ({ gpuFrameMs: 20, shadowPagesDrawn: k < 5 ? 2 : 90, shadowPagesRefetched: k }),
    ],
    ['close', 11, 10, () => ({ gpuFrameMs: null, shadowPagesDrawn: null })],
    ['far', 1, 10, healthy],
  ]);
  assert.deepEqual(lines['far: FPS'], [null, '—']);
  assert.deepEqual(lines['pan: GPU frame'], [false, '20.00 ms ≤ 16.67 ms']);
  assert.deepEqual(lines['pan: shadow pages drawn'], [null, '90']);
  assert.deepEqual(lines['pan: shadow pages refetched'], [null, '10']);
  const close = Object.entries(lines).filter(([name]) => /^close: [^F]/.test(name));
  assert.deepEqual(
    close.map(([, line]) => line),
    Array(4).fill([null, '—']),
  );
});

test("a backend's documented limit is a neutral line; any other refusal or uncaught error is red", () => {
  const { correct, lines } = judged(
    [[null as never, 10, 10, healthy]],
    [['no shadows', true], ['no toon'], ['boom, until #1'], ['no toon']],
  );
  assert.equal(correct, false);
  assert.deepEqual(Object.keys(lines), ['refused: webgl2', 'refused']);
  assert.deepEqual(lines['refused: webgl2'], [null, 'no shadows']);
  assert.deepEqual(lines.refused, [false, 'no toon; boom, until #1']);
});
