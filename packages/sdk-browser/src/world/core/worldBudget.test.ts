import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionPools, worldBudget, worldPools, type Pools } from './worldBudget.ts';
import { DEFAULT_TEXTURE_POOL_BUDGET } from '../../webgpu/residency/memoryBudgets.ts';
import { DEFAULT_GEOMETRY_POOL_BUDGET } from '../../residency/pools.ts';
import {
  BOUNCE_PROBE_BYTES,
  DEFAULT_CPU_BUDGET,
  DEFAULT_GPU_BUDGET,
  EFFECT_TARGET_BYTES,
  SHADOW_HOST_BYTES,
  SHADOW_POOL_BYTES,
  SHADOW_POOL_PAGES,
} from '../../residency/memoryBudget.ts';
import { shadowAtlasBytes, shadowBufferBytes } from '../../gpu/shadow/atlas.ts';
import { SHADOW_BATCH_GPU_BYTES, SHADOW_BATCH_HOST_BYTES } from '../../gpu/shadow/batchBudget.ts';
import { shadowTransmittanceBytes } from '../../gpu/shadow/transmittance.ts';
import {
  SHADOW_TABLE_ENTRIES,
  shadowPoolSize,
  shadowPoolShape,
} from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { createShadowPlan } from '../../../../sdk-core/src/scene/light-shadow/plan.ts';
import { DEFAULT_CACHED_BYTES } from '../../streaming/pageCache.ts';
import { DEFAULT_PHYSICS_BUDGET } from '../../../../sdk-core/src/physics/index.ts';
import { createBounceCascades, type FrameMetrics } from '../../../../sdk-core/src/index.ts';
import { bounceProbeBytes } from '../../bounce/limits.ts';
import type { WorldRenderer } from '../capability/worldReady.ts';

const budget = (
  renderer: WorldRenderer | null,
  frame: Partial<FrameMetrics> | null,
  asked: Omit<Pools, 'pageCache'> = {},
  pools: Pools = Object.assign(worldPools(), asked),
) =>
  worldBudget(pools, { explorer: null }, { last: frame as FrameMetrics | null }, () => renderer, {
    ...DEFAULT_PHYSICS_BUDGET,
  });

test('texturePool is null on WebGL2, which holds no texture pool', () => {
  assert.equal(budget('webgl2', { texturePoolBytes: null }).texturePool, null);
  assert.equal(budget('webgl2', null, { texturePool: 1024 }).texturePool, null);
});

test('texturePool on WebGPU falls back to the asked budget while no pool was published', () => {
  assert.equal(
    budget('webgpu', { texturePoolBytes: null }, { texturePool: 4096 }).texturePool,
    4096,
  );
  assert.equal(
    budget('webgpu', { texturePoolBytes: null }).texturePool,
    DEFAULT_TEXTURE_POOL_BUDGET,
  );
  assert.equal(budget(null, null).texturePool, DEFAULT_TEXTURE_POOL_BUDGET);
});

test('texturePool on WebGPU reads what the last frame held', () => {
  assert.equal(
    budget('webgpu', { texturePoolBytes: 2048 }, { texturePool: 4096 }).texturePool,
    2048,
  );
});

test('raycastTrees reads and sets the raycast tree cache budget', () => {
  const handle = budget(null, null);
  const before = handle.raycastTrees;
  handle.raycastTrees = 1024;
  assert.equal(handle.raycastTrees, 1024);
  handle.raycastTrees = before;
});

const MiB = 1024 * 1024;

test("the default totals split into each pool's own default", () => {
  const handle = budget('webgpu', null);
  assert.equal(handle.gpu, DEFAULT_GPU_BUDGET);
  assert.equal(handle.cpu, DEFAULT_CPU_BUDGET);
  assert.deepEqual(handle.split, {
    shadowPool: SHADOW_POOL_BYTES,
    bounceProbes: BOUNCE_PROBE_BYTES,
    effectTargets: EFFECT_TARGET_BYTES,
    geometryPool: DEFAULT_GEOMETRY_POOL_BUDGET,
    texturePool: DEFAULT_TEXTURE_POOL_BUDGET,
    shadowMirror: SHADOW_HOST_BYTES,
    pageCache: DEFAULT_CACHED_BYTES,
    textureLevels: (3 * DEFAULT_CACHED_BYTES) / 4,
  });
  assert.equal(handle.geometryPool, DEFAULT_GEOMETRY_POOL_BUDGET);
});

test('the shadow share counts the pool at 3840 × 2160 under one sun, and the page table', () => {
  assert.ok(shadowBufferBytes(0) >= SHADOW_TABLE_ENTRIES * 4);
  const { side, layers } = shadowPoolShape(shadowPoolSize(3840, 2160));
  // Two layers of 53² pages: the atlas and its static layer, 351 MiB each; transmittance, half.
  assert.deepEqual([side, layers, SHADOW_POOL_PAGES], [53, 2, 5618]);
  assert.equal(shadowAtlasBytes(side, layers), 5618 * 64 * 1024);
  const pool = 2 * shadowAtlasBytes(side, layers) + shadowTransmittanceBytes(side, layers);
  const buffers = shadowBufferBytes(SHADOW_POOL_PAGES) + SHADOW_BATCH_GPU_BYTES;
  assert.equal(SHADOW_POOL_BYTES, pool + buffers);
  assert.equal(budget('webgpu', null).split.shadowPool, SHADOW_POOL_BYTES);
});

test('the CPU total counts the shadow table host mirror before the page cache', () => {
  // What a real table, pool and list allocate at the largest pool, whatever the screen: one size.
  const { table, pool, admission } = createShadowPlan(53, 2);
  const host = table.hostBytes + pool.hostBytes + admission.hostBytes + SHADOW_BATCH_HOST_BYTES;
  assert.equal(SHADOW_HOST_BYTES, host);
  assert.ok(SHADOW_HOST_BYTES > SHADOW_TABLE_ENTRIES * 5, 'the words and their change flags');
  assert.equal(DEFAULT_CPU_BUDGET, SHADOW_HOST_BYTES + DEFAULT_CACHED_BYTES);
  for (const total of [SHADOW_HOST_BYTES + 1, DEFAULT_CPU_BUDGET, 4096 * MiB]) {
    const handle = budget('webgpu', null, { cpu: total });
    const { shadowMirror, pageCache } = handle.split;
    assert.equal(shadowMirror + pageCache, total, `${total}`);
    assert.equal(shadowMirror, SHADOW_HOST_BYTES);
  }
});

const FIXED = SHADOW_POOL_BYTES + BOUNCE_PROBE_BYTES + EFFECT_TARGET_BYTES;

test('a GPU total redraws every pool by the split, and the pools never sum past it', () => {
  for (const total of [FIXED + 2 * MiB, FIXED + 300 * MiB, 8192 * MiB]) {
    const pools = worldPools();
    const handle = budget('webgpu', null, {}, pools);
    handle.gpu = total;
    const { shadowPool, bounceProbes, geometryPool, texturePool } = handle.split;
    assert.ok(shadowPool + bounceProbes + geometryPool + texturePool <= total, `${total}`);
    assert.deepEqual(
      { ...pools, pageCache: undefined },
      { gpu: total, geometryPool, texturePool, pageCache: undefined },
    );
    // A pool set alone stays within what the total leaves it.
    handle.geometryPool = DEFAULT_GEOMETRY_POOL_BUDGET;
    handle.texturePool = DEFAULT_TEXTURE_POOL_BUDGET;
    assert.ok(FIXED + handle.geometryPool + handle.texturePool! <= total, `${total}`);
  }
});

// #487's audit: the shadow pool a screen takes, with its static layer and fixed buffers, is sized
// inside `split.shadowPool`, and a total below 512 MiB never lets the pools sum past it.
test('the shadow pool of any screen fits its share, and totals below 512 MiB never overflow', () => {
  const { shadowPool } = budget('webgpu', null).split;
  const screens = [1, 1, 1280, 720, 3840, 2160, 16384, 16384, Infinity, Infinity];
  for (let i = 0; i < screens.length; i += 2) {
    const [w, h] = [screens[i], screens[i + 1]];
    const pages = Math.min(shadowPoolSize(w, h), SHADOW_POOL_PAGES),
      { side, layers } = shadowPoolShape(pages);
    const taken = 2 * shadowAtlasBytes(side, layers) + shadowBufferBytes(side * side * layers);
    assert.ok(taken <= shadowPool, `${w}×${h}`);
  }
  for (const total of [64 * MiB, 256 * MiB, 511 * MiB, FIXED - 1]) {
    const pools = worldPools();
    const handle = budget('webgpu', null, {}, pools);
    assert.throws(() => (handle.gpu = total), /GPU_BUDGET_UNDER_SHADOW_POOL/, `${total}`);
    assert.equal(handle.gpu, DEFAULT_GPU_BUDGET, 'a refused total leaves the one in place');
    assert.equal(pools.gpu, undefined);
  }
  const least = budget('webgpu', null, { gpu: FIXED + 2 }).split;
  const { shadowPool: shadows, bounceProbes: probes, geometryPool: g, texturePool: t } = least;
  assert.ok(shadows + probes + g + t <= FIXED + 2);
});

test('the GPU total counts the bounce probes at their largest, before the pools', () => {
  // Both copies of a city's cascades — every level followed — are the largest the probes take;
  // a room holds fewer levels and fits inside.
  const city = createBounceCascades([0, 0, 0, 8000, 300, 8000]);
  const room = createBounceCascades([0, 0, 0, 6, 3, 6]);
  assert.equal(2 * bounceProbeBytes(city.probes), BOUNCE_PROBE_BYTES);
  assert.ok(2 * bounceProbeBytes(room.probes) < BOUNCE_PROBE_BYTES);
  for (const total of [DEFAULT_GPU_BUDGET, FIXED + 8 * MiB]) {
    const handle = budget('webgpu', null, { gpu: total });
    const { shadowPool, bounceProbes, geometryPool, texturePool } = handle.split;
    assert.equal(bounceProbes, BOUNCE_PROBE_BYTES);
    assert.ok(shadowPool + bounceProbes + geometryPool + texturePool <= total, `${total}`);
  }
});

test('a total the rule cannot take is refused by name and changes nothing', () => {
  const pools = worldPools();
  const handle = budget('webgpu', null, {}, pools);
  assert.throws(() => (handle.gpu = 0), /INVALID_GPU_BUDGET/);
  // The shadows never shrink: a total under the pool they take is refused, never squeezed.
  assert.throws(() => (handle.gpu = SHADOW_POOL_BYTES - 1), /GPU_BUDGET_UNDER_SHADOW_POOL/);
  assert.equal(handle.split.shadowPool, SHADOW_POOL_BYTES);
  assert.throws(() => (handle.cpu = 1.5), /INVALID_CPU_BUDGET/);
  // The mirror never shrinks either: a CPU total that leaves the page cache nothing is refused.
  assert.throws(() => (handle.cpu = SHADOW_HOST_BYTES), /CPU_BUDGET_UNDER_SHADOW_MIRROR/);
  assert.deepEqual({ ...pools, pageCache: undefined }, { pageCache: undefined });
  assert.equal(pools.pageCache.cpuBytes, DEFAULT_CACHED_BYTES);
  handle.cpu = 64 * MiB;
  assert.equal(handle.split.pageCache, 64 * MiB - SHADOW_HOST_BYTES);
});

test("a CPU total applies live to the world's page cache, the one every session reads through", () => {
  const pools = worldPools();
  const handle = budget('webgpu', null, {}, pools);
  const page = new Uint8Array(MiB);
  for (let i = 0; i < 8; i++) pools.pageCache.touch(`p${i}`, page);
  handle.cpu = SHADOW_HOST_BYTES + 3 * MiB;
  assert.equal(pools.pageCache.cpuBytes, 3 * MiB);
  // No session reads: pages leave oldest first, at once, not at the next scene load.
  assert.deepEqual([...pools.pageCache.pages.keys()], ['p5', 'p6', 'p7']);
  // Every session the world opens — a reopen after a device loss among them — reads this cache.
  assert.equal(sessionPools(pools).pageCache, pools.pageCache);
  assert.equal(sessionPools(pools).pageCache, sessionPools(pools).pageCache);
});
