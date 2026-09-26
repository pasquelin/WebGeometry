// The memory a frame's shadow batches add (#489, #483 rule 5): sized once from the largest pool —
// its pages in full batches, each in at most one light cut's views —, never grown at run time, and
// counted in the memory budget from that one rule. Checked here against what the modules allocate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYER_PAGES } from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { fakeDevice } from '../../../../../tests/kit/gpu/fakeDevice.ts';
import { createLightCutRedraws } from '../dag/lightCutRedraws.ts';
import { DAG_MAX_VIEWS } from '../dag/shader/viewsWgsl.ts';
import { createCpuCasterLists } from '../../webgpu/shadow/cpuCasters.ts';
import { SHADOW_HOST_BYTES, SHADOW_POOL_BYTES } from '../../residency/memoryBudget.ts';
import { shadowBatchWrites } from './batchWrites.ts';
import { createGpuShadowCullCounts } from './cullCounts.ts';
import { MAX_SHADOW_PAGES } from './recordPack.ts';
import {
  MAX_SHADOW_BATCHES,
  MAX_SHADOW_RUNS,
  SHADOW_BATCH_GPU_BYTES,
  SHADOW_BATCH_HOST_BYTES,
  SHADOW_BATCH_WRITE_BYTES,
  SHADOW_COUNT_SAMPLERS,
  SHADOW_FLAG_FRAMES,
} from './batchBudget.ts';

const MiB = 1024 * 1024;

test('a frame draws at most one pool layer in full batches, each in one cut of views', () => {
  assert.equal(LAYER_PAGES, 4096);
  assert.equal(MAX_SHADOW_BATCHES, Math.ceil(LAYER_PAGES / MAX_SHADOW_PAGES));
  assert.equal(MAX_SHADOW_BATCHES, 171);
  assert.equal(MAX_SHADOW_RUNS, MAX_SHADOW_BATCHES * DAG_MAX_VIEWS);
});

test('the GPU bytes the batches add are what the staging, flags, CPU lists and counts allocate', () => {
  const { device, buffers } = fakeDevice();
  const target = device.createBuffer({ size: SHADOW_BATCH_WRITE_BYTES, usage: 0 });
  const writes = shadowBatchWrites(device);
  writes.stage(device.createCommandEncoder());
  writes.write(target, 0, Uint32Array.of(1));
  writes.end();
  createLightCutRedraws((d) => device.createBuffer(d), target, DAG_MAX_VIEWS);
  const lists = createCpuCasterLists(device, 1);
  // The cull's and the occlusion test's count samples.
  for (let k = 0; k < SHADOW_COUNT_SAMPLERS; k++) createGpuShadowCullCounts(device);
  const made = buffers.filter(
    (buffer) => buffer !== (target as unknown) && buffer !== (lists.source as unknown),
  );
  const gpu = made.reduce((sum, { size }) => sum + size, 0);
  assert.equal(gpu, SHADOW_BATCH_GPU_BYTES);
  assert.ok(SHADOW_BATCH_GPU_BYTES < 5 * MiB, `${SHADOW_BATCH_GPU_BYTES} bytes`);
  const cpuHost = lists.bases.byteLength + lists.lengths.byteLength + lists.commands.byteLength;
  assert.equal(cpuHost, MAX_SHADOW_RUNS * 24);
  assert.ok(SHADOW_BATCH_HOST_BYTES > SHADOW_FLAG_FRAMES * MAX_SHADOW_BATCHES * MAX_SHADOW_PAGES);
});

test('the memory budget counts the batches with the shadows', () => {
  assert.ok(SHADOW_POOL_BYTES > SHADOW_BATCH_GPU_BYTES);
  assert.ok(SHADOW_HOST_BYTES > SHADOW_BATCH_HOST_BYTES);
});
