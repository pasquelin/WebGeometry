// #483 rules 1 and 2: never show an incomplete frame. The shadow pool is granted asynchronously
// (`poolSize.ts`); the frame that first casts a shadow is held until the device answered, so no
// presented image lacks the shadow pass while a light casts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shadowPoolSize as pages,
  shadowPoolShape,
} from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { SUN } from '../../../../sdk-core/src/scene/light-shadow/lightShadow.fixture.ts';
import { asWebgpuDevice } from '../../../../../tests/kit/gpu/webgpuDevice.ts';
import { createWebgpuLightState } from '../pages/state/lights.ts';
import { holdWebgpuFrame } from '../frame/hold.ts';
import { settledRt } from '../frame/hold.fixture.ts';
import { sizeShadowPool } from './poolSize.ts';
import { captureColorView } from '../pages/io/colorCapture.ts';
import type { HostCamera } from '../../camera/world.ts';

/** A session whose device refuses every texture past `limit` bytes, and a frame loop reduced to
 *  what `renderWebgpuPages` does around the pool: size it, hold or draw, wait for the next frame.
 *  `shown` records, per presented image, whether the shadow pass could draw in it. */
function frames(limit = Infinity) {
  const rt = settledRt();
  const lights = createWebgpuLightState(shadowPoolShape(pages(300, 150)).side);
  let texture: object | undefined;
  const gpu = asWebgpuDevice({
    createTexture: ({ size }: { size: number[] }) => {
      if (size[0] * size[1] * 4 > limit) gpu.raise('Out of memory');
      return { destroy() {}, createView: () => ({}) };
    },
    queue: { onSubmittedWorkDone: async () => {} },
  });
  lights.shadows = {
    get texture() {
      return texture;
    },
    makePool: (side: number, layers: number) =>
      gpu.device.createTexture({
        size: [side * 128, side * 128, layers],
        format: 'depth32float',
        usage: 0,
      }),
    sizePool: (_: number, __: number, made: object) => void (texture = made),
  } as unknown as NonNullable<typeof lights.shadows>;
  lights.store.add({ ...SUN, id: 'shadow sun' });
  const shown: boolean[] = [],
    said: string[] = [];
  let lastImage = false;
  Object.assign(rt, {
    lights,
    setup: { viewport: [1280, 720] },
    signal: new AbortController().signal,
    diag: {
      engineDiagnostic: (phase: string) => said.push(phase),
      diagnosticFailure: (phase: string) => said.push(phase),
    },
  });
  Object.assign(rt.gpu, {
    device: gpu.device,
    presenter: { present: () => shown.push(lastImage) },
    colorTexture: {},
  });
  const hold = {
    createCommandEncoder: () => ({ finish: () => ({}) }),
    queue: { submit() {} },
  } as unknown as GPUDevice;
  const frame = async () => {
    sizeShadowPool(rt);
    if (!holdWebgpuFrame(rt, hold)) {
      lastImage = texture !== undefined;
      rt.run.imageRevision++;
      shown.push(lastImage);
    }
    // `pendingWebgpuFrame`: a grant the device still answers for asks the next frame.
    const grant = lights.shadowGrant;
    if (grant && !grant.settled) await grant.done;
  };
  return { rt, gpu, shown, said, frame, granted: () => texture !== undefined };
}

test('no presented frame lacks the shadow pass while a light casts', async () => {
  const s = frames();
  for (let i = 0; i < 3; i++) await s.frame();
  assert.equal(s.shown[0], true, 'the first presented image already has its shadows');
  assert.ok(s.shown.every(Boolean), `${s.shown}`);
  assert.equal(s.rt.run.frameHeld, false, 'once granted, frames draw again');
});

test('a refused pool is held for, then drawn smaller with its shadows', async () => {
  const s = frames((shadowPoolShape(pages(1280, 720)).side * 128) ** 2);
  for (let i = 0; i < 2; i++) await s.frame();
  assert.deepEqual(s.said, ['gpu-out-of-memory', 'shadow-pool']);
  assert.deepEqual(s.shown, [true], 'the smaller pool still draws the shadow pass');
});

test('a pool refused at its floor is not waited for forever: shadows-off, then frames draw', async () => {
  const s = frames(0);
  for (let i = 0; i < 2; i++) await s.frame();
  assert.deepEqual(s.said, ['gpu-out-of-memory', 'shadows-off']);
  assert.equal(s.shown.length, 1, 'the frame after the refusal is drawn');
});

for (const asked of ['by a frame', 'by the capture'])
  test(`a capture waits for the shadow pool asked ${asked}, never drawn without its shadows`, async () => {
    const s = frames();
    // The device answers for the pool only once the capture is under way.
    let answer = () => {};
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const pop = s.gpu.device.popErrorScope.bind(s.gpu.device);
    Object.assign(s.gpu.device, { popErrorScope: async () => (await answered, pop()) });
    // The capture's render reads the signal first: what the pool is then is what it draws with.
    let drawnWithPool: boolean | undefined;
    Object.assign(s.rt, {
      context: {
        get signal() {
          drawnWithPool ??= s.granted();
          return { aborted: true, throwIfAborted: () => assert.fail('drawn') };
        },
      },
    });
    Object.assign(s.rt.run, {
      lastCamera: {},
      motion: {},
      diagnostic: 'beauty',
      temporalHizState: {},
    });
    Object.assign(s.rt.services, { residency: { busy: false, pending: undefined } });
    // The frame targets already fit the capture's size: nothing else is asked of the device.
    Object.assign(s.rt.gpu, { targetSize: [64, 64], surfaces: {} });
    Object.assign(s.rt.vis, { visTexture: {} });
    if (asked === 'by a frame') sizeShadowPool(s.rt);
    const capture = captureColorView(s.rt, {} as HostCamera, { width: 64, height: 64 });
    // The capture runs up to its first wait before the call returns: it is under way, and waits.
    assert.equal(s.rt.capture.capturing, true, 'the capture began before the device answered');
    answer();
    await assert.rejects(capture, /drawn/);
    assert.equal(drawnWithPool, true, 'the capture drew after the device granted the pool');
  });
