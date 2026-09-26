// The static layer's page pyramids are built by the camera's Hi-Z kernels, one pyramid per page
// in the same dispatches: level 0 copied from the page's texels, each next level reduced from the
// one before, every pyramid `PAGE_HIZ_WORDS` apart.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeDevice } from '../../../../../tests/kit/gpu/fakeDevice.ts';
import {
  PAGE_HIZ_LEVELS,
  PAGE_HIZ_OFFSETS,
  PAGE_HIZ_WORDS,
  createShadowPageHiz,
} from './pageHiz.ts';

/** A compute encoder that records the size of each dispatch. */
function recordingEncoder() {
  const dispatches: number[][] = [];
  const pass = {
    setBindGroup() {},
    setPipeline() {},
    dispatchWorkgroups: (...size: number[]) => dispatches.push(size),
    end() {},
  };
  const encoder = { beginComputePass: () => pass } as unknown as GPUCommandEncoder;
  return { encoder, dispatches };
}

test('a page pyramid is 128² then every half down to one texel, one per page', async () => {
  assert.equal(PAGE_HIZ_LEVELS, 8);
  assert.deepEqual(PAGE_HIZ_OFFSETS.slice(0, 3), [0, 16384, 20480]);
  assert.equal(PAGE_HIZ_WORDS, 21845);
  const { device, writes } = fakeDevice();
  const { encoder, dispatches } = recordingEncoder();
  const hiz = await createShadowPageHiz(device, {} as GPUTextureView);
  const slots = new Uint32Array(writes[0].data.buffer),
    slot = (l: number) => Array.from(slots.subarray(l * 64, l * 64 + 7));
  assert.deepEqual(slot(0), [128, 128, 0, 0, 0, 0, PAGE_HIZ_WORDS], 'copy: 128², stride');
  assert.deepEqual(slot(1), [0, 128, 128, 16384, 64, 64, PAGE_HIZ_WORDS]);
  assert.deepEqual(slot(7), [PAGE_HIZ_OFFSETS[6], 2, 2, PAGE_HIZ_OFFSETS[7], 1, 1, PAGE_HIZ_WORDS]);
  hiz.encode(encoder, 3, (page, out, at) => {
    out[at] = page * 128;
    out[at + 1] = 256;
  });
  assert.deepEqual(dispatches[0], [16, 16, 3], 'level 0 of three pages at once');
  assert.deepEqual(dispatches.at(-1), [1, 1, 3]);
  assert.equal(dispatches.length, PAGE_HIZ_LEVELS);
  const origins = new Int32Array(writes[1].data.buffer);
  assert.deepEqual([origins[12], origins[13]], [128, 256], "the second page's first texel");
});
