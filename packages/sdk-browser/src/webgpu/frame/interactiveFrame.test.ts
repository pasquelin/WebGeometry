// A light that lands while the loop waits on something else starts the contract program's compile
// in a frame whose drain never runs; the frames after it are held. The drain of a held frame must
// still wait for that program, or the loop idles on the unlit image until a foreign invalidation
// (#370, #536). Real bricks: the scheduler, `pendingWebgpuFrame`, the deferred lighting, the hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { holdWebgpuFrame, keepWebgpuFrame } from './hold.ts';
import { pendingWebgpuFrame } from './interactiveFrame.ts';
import { createDeferredLighting } from '../../lighting/deferred/deferred.ts';
import { wantsContractLighting } from '../pages/prepare/lightResources.ts';
import { createExplorerFrameScheduler } from '../../world/render/frameScheduler.ts';
import { installGpuGlobals } from '../../../../../tests/kit/gpu/globals.ts';
import { deferredLightingHarness, settledRt, surface, view } from './hold.fixture.ts';

installGpuGlobals();

const turn = () => new Promise((done) => setImmediate(done));

/** The loop idle on the unlit image, held, while the contract program still compiles. */
async function heldWhileCompiling() {
  const h = deferredLightingHarness();
  const rt = settledRt();
  const store = { count: 0, unlit: true };
  let texturesServed = () => {};
  const textures = new Promise<void>((done) => (texturesServed = done));
  Object.assign(rt.lights, { store });
  Object.assign(rt.vis, { textures: { counters: { pending: 0 }, settled: () => textures } });
  // The wiring of `../pages/prepare/prepare.ts`: an arrived program breaks the hold.
  const lighting = await createDeferredLighting(h.device, () => rt.run.gate.resourcesChanged());
  rt.gpu.deferred = lighting;
  const requested: FrameRequestCallback[] = [];
  const scheduler = createExplorerFrameScheduler({
    request: (callback) => requested.push(callback),
    cancel() {},
    // `renderWebgpuPages` reduced to its two outcomes: the frame held, or encoded and kept.
    render() {
      if (holdWebgpuFrame(rt, h.device)) return;
      lighting.bind(
        surface,
        view(),
        view(),
        wantsContractLighting(rt),
        { lights: {} as GPUBuffer },
        () => {},
      );
      rt.run.frame++;
      keepWebgpuFrame(rt);
    },
    pending: () => pendingWebgpuFrame(rt),
    error: (error) => assert.fail(String(error)),
    limited: () => assert.fail('the loop hit its frame limit'),
  });
  const draw = () => requested.shift()!(0);

  // An unlit frame whose drain passes the contract check, then waits on a texture tile.
  scheduler.invalidate();
  draw();
  await turn();
  // The lights land: `refreshSceneLights` breaks the hold, the page asks for frames.
  Object.assign(store, { count: 1, unlit: false });
  rt.run.gate.sceneChanged();
  for (let frame = 0; frame < 8 && !rt.run.frameHeld; frame++) {
    scheduler.invalidate();
    draw();
  }
  assert.equal(rt.run.frameHeld, true, 'the frames after the lights are held');
  assert.equal(lighting.usesContract, false, 'the program still compiles: the image is unlit');

  // The tile lands: the waiting drain asks one frame, held again; the page asks nothing more.
  texturesServed();
  await turn();
  draw();
  assert.equal(rt.run.frameHeld, true);
  await turn();
  assert.equal(requested.length, 0, 'the loop waits');
  return { h, lighting, requested, draw, scheduler };
}

test('a loop held while the contract program compiles draws the lit frame when it lands', async () => {
  const { h, lighting, requested, draw, scheduler } = await heldWhileCompiling();
  h.finishCompilation();
  await lighting.settle();
  await turn();
  assert.equal(requested.length, 1, 'the arrived program asks its frame');
  draw();
  assert.equal(lighting.usesContract, true, 'the lights now light the image');
  scheduler.dispose();
});

test('a contract program that fails to compile leaves the held loop idle', async () => {
  const { h, lighting, requested, scheduler } = await heldWhileCompiling();
  h.failCompilation();
  await lighting.settle();
  await turn();
  // Nothing arrived, so nothing changed: no held frame is redrawn after the reported failure.
  assert.equal(requested.length, 0, 'the failed program asks no frame');
  assert.equal(lighting.usesContract, false);
  scheduler.dispose();
});
