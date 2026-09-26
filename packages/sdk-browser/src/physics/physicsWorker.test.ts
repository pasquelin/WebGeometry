import test from 'node:test';
import assert from 'node:assert/strict';
import { PHYSICS_STEP } from '../../../sdk-core/src/physics/index.ts';
import { startedWorker } from './worker.fixture.ts';

test('a tick of several steps reports its slowest step as stepMaxMs, not their mean', async () => {
  // The worker's clock: each read returns `now`, then moves it on by the next scripted amount.
  let now = 0;
  const advances: number[] = [];
  const clock = () => {
    const read = now;
    now += advances.shift() ?? 0;
    return read;
  };
  // The worker's ticks run when the test says, never on a timer.
  const { ticks, sent, receive } = await startedWorker(clock);
  ticks.shift()![0](); // At start, nothing owed yet.
  // A command wakes the world: one step owed; two more steps of time pass before the tick.
  receive({ type: 'commands', words: new Uint32Array(0) });
  now += 2 * PHYSICS_STEP * 1000 + 1;
  // The tick reads the clock once, then twice per step: steps of 2, 9 and 4 ms.
  advances.push(0, 2, 0, 9, 0, 4, 0);
  ticks.shift()![0]();
  const results = sent.filter((m) => m.type === 'results');
  assert.equal(results.length, 1);
  const [tick] = results;
  assert.equal(tick.steps, 3);
  assert.equal(tick.stepMs, 15, 'the steps summed');
  assert.equal(tick.stepMaxMs, 9, 'the slowest step, not the mean (5) nor 0');
});
