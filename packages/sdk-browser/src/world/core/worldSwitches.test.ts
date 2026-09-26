import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeasuredWorld } from '../session/explorer.ts';
import { sessionOptions } from './worldOptions.ts';
import { worldSwitches } from './worldSwitches.ts';
import { GraphSurface } from '../../host/graph/surface.ts';
import { effect } from '../../../../sdk-core/src/world/effect/index.ts';

/** The world's notices, where nothing here is said. */
const silent = { once() {}, say() {} };

/** An open session that records the switches written into it. */
function session(draws = true) {
  const written: boolean[] = [];
  let on = draws;
  const explorer = {
    setTemporalAntialiasing: (next: boolean) => void (written.push(next), (on = next)),
    temporalAntialiasing: () => on,
  } as unknown as MeasuredWorld;
  return { explorer, written };
}

// #363: `createWorld(…, { temporalAntialiasing: false })` opens its sessions with it off, and
// the property flips the open session in place, never reopening it.
test('temporal antialiasing is given to the session and switched in place', () => {
  const open = session(false);
  let renewed = 0,
    invalidated = 0;
  const runtime = { explorer: null as MeasuredWorld | null, renew: () => void renewed++ };
  const device = { renderer: 'webgpu' as const };
  const options = { temporalAntialiasing: false };
  const switches = worldSwitches(
    options,
    () => runtime,
    device,
    () => void invalidated++,
    silent,
  );
  assert.equal(sessionOptions(options, switches.held).temporalAntialiasing, false);
  assert.equal(switches.temporalAntialiasing, false, 'before a session: what the page asked');
  runtime.explorer = open.explorer;
  switches.temporalAntialiasing = true;
  switches.temporalAntialiasing = true;
  assert.deepEqual(open.written, [true], 'written once, into the open session');
  assert.equal(switches.temporalAntialiasing, true, 'read back from the session');
  assert.equal(sessionOptions(options, switches.held).temporalAntialiasing, true, 'kept on reopen');
  assert.deepEqual([renewed, invalidated], [0, 1]);
});

test('temporal antialiasing reads false on WebGL2 and as the session draws it', () => {
  const runtime = { explorer: null as MeasuredWorld | null, renew() {} };
  const switches = worldSwitches(
    {},
    () => runtime,
    { renderer: 'webgl2' },
    () => {},
    silent,
  );
  assert.equal(switches.held.temporalAntialiasing, true, 'on by default');
  assert.equal(switches.temporalAntialiasing, false, 'WebGL2 has none');
  runtime.explorer = session(false).explorer;
  assert.equal(switches.temporalAntialiasing, false);
});

// #349: `world.effects` is one chain for the world's life, handed to every session it opens; a
// change of it asks for a frame, and reopens nothing.
test('the effect chain is given to every session, and a change of it asks for a frame', () => {
  let renewed = 0,
    invalidated = 0;
  const said: string[] = [];
  const runtime = { explorer: null as MeasuredWorld | null, renew: () => void renewed++ };
  const switches = worldSwitches(
    {},
    () => runtime,
    { renderer: 'webgpu' },
    () => void invalidated++,
    { once: (kind) => void said.push(kind), say: (kind) => void said.push(kind) },
  );
  const chain = switches.held.effects;
  assert.equal(sessionOptions({}, switches.held).effects, chain);
  chain.add(effect.bloom());
  (chain.passes[0] as ReturnType<typeof effect.bloom>).radius = 2;
  assert.equal(sessionOptions({}, switches.held).effects, chain, 'the same chain on reopen');
  assert.deepEqual([invalidated, renewed], [2, 0]);
  // A WebGL2 frame drawn without the chain is said on the world's own channel.
  sessionOptions({}, switches.held).effectsRefused!('multiply');
  assert.deepEqual(said, ['effects-refused-blending']);
  // A surface WebGL2 draws without a physical feature is said on the same channel (#772).
  sessionOptions({}, switches.held).materialDegraded!(new GraphSurface('physical'), ['clearcoat']);
  assert.deepEqual(said, ['effects-refused-blending', 'material-degraded']);
});
