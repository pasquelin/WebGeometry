// A held frame redisplays the previous frame's target. It still published the draw counters and
// the step durations of the last full render, i.e. work it had not done. It now publishes the
// present alone, and leaves intact the metrics of the cut it redisplays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameGateCore } from '../../frame/gateCore.ts';
import { HOLD_SIGNATURE_VALUES } from './signature.ts';
import { CPU_STEP, CPU_STEP_NAMES } from '../pages/render/cpuStepTable.ts';
import { holdWebgpuFrame } from './hold.ts';
import { metricsOf } from '../pages/io/metrics.ts';
import { fakeDevice } from '../../../../../tests/kit/gpu/fakeDevice.ts';
import type { WebgpuPagesRuntime } from '../pages/runtime.ts';

/** An engine whose every `frameSettled` condition is true and whose last complete frame drew a
 *  lot: that is what hold must not republish. */
function tenue() {
  const gate = createFrameGateCore(HOLD_SIGNATURE_VALUES);
  gate.hold.keep(gate.revisions);
  gate.hold.keep(gate.revisions);
  const run = {
    gate,
    frameHeld: false,
    frame: 5,
    lost: false,
    desired: [],
    drawn: [],
    gpuFrameActive: true,
    gpuMetricsReady: true,
    cutHeld: true,
    overBudget: false,
    coverageBudgetLimited: false,
    noOccluderHistory: false,
    deferredDrops: new Set(),
    imageRevision: 3,
    gpuDrawCalls: 42,
    blendDrawCalls: 7,
    submittedTriangles: 123456,
    blendSubmittedTriangles: 99,
    cpuSelectMs: 3.5,
    // What the frame SHOWS: the cut, which does not move.
    visible: 800,
    selectedTriangles: 123456,
    frustumRejected: 29987,
    lodLevel: 2,
    blendFrustumRejected: 11,
    cpuHizCounted: false,
  };
  const timing = {
    frameEncoder: undefined,
    lastGpuPassMs: { frame: 4, totalMs: 9, passes: [], truncated: false },
    lastGpuFrameMs: 9,
    lastGpuHostGapMs: 2,
    lastSubmitMs: 8,
    cpuProfile: { row: new Float64Array(CPU_STEP_NAMES.length).fill(7) },
    rowFilled: false,
    cpuSample: { version: 1 },
    partitionCounts: {},
  };
  const rt = {
    run,
    timing,
    context: {},
    gpu: {
      presenter: { present: () => {} },
      colorTexture: {},
      targetSize: [4, 4],
      cache: undefined,
      vertexBytes: 0,
      positionBuffers: new Map(),
    },
    vis: { visEnabled: true, gpuDraw: {}, textureJobs: [], gpuHiz: undefined },
    capture: { capturing: false, capturePending: undefined },
    setup: { geometryPool: { slots: 0 }, texturePool: {} },
    services: {
      bootstrapState: { ready: true },
      residencySets: { keepCount: 0 },
      residency: { busy: false },
      // Count of cut pages still waiting for their bytes, held by the difference.
      cutPending: { count: 0 },
    },
    layout: {
      rows: {
        rowsChanged: false,
        dirtyFrom: 1,
        dirtyTo: -1,
        rowsEpoch: 1,
        tableEpoch: 1,
        candidateOverflow: false,
      },
    },
    lights: {
      plan: {
        counts: { pendingPages: 0, waitedMs: 0, cachedPages: 0, poolPages: 0 },
        pool: { refetched: 0 },
        requests: { counts: { requested: 0 } },
      },
    },
    bounce: { probes: undefined },
    blendState: { visibleBlend: [] },
  } as unknown as WebgpuPagesRuntime;
  const { device } = fakeDevice();
  return { rt, run, timing, device };
}

test('a held frame counts only its present, not the last full render', () => {
  const { rt, run, timing, device } = tenue();
  assert.equal(holdWebgpuFrame(rt, device), true, 'the frame should have been held');
  assert.equal(run.frameHeld, true);
  assert.equal(run.gpuDrawCalls, 1, 'the present is the only draw call');
  assert.equal(run.blendDrawCalls, 0);
  assert.equal(run.submittedTriangles, 0, 'no triangle was submitted');
  assert.equal(run.blendSubmittedTriangles, 0);
  assert.equal(run.cpuSelectMs, null, 'no CPU cut ran');
  assert.equal(timing.lastGpuPassMs, null, 'no pass was timed');
  assert.equal(timing.lastGpuFrameMs, null);
  assert.equal(timing.lastGpuHostGapMs, null);
});

test('step durations of a held frame describe only the present', () => {
  const { rt, timing, device } = tenue();
  holdWebgpuFrame(rt, device);
  const row = timing.cpuProfile.row;
  const presentation = new Set([
    CPU_STEP.queueSubmitMs,
    CPU_STEP.encodeSubmitMs,
    CPU_STEP.submitMs,
    CPU_STEP.totalMs,
  ]);
  assert.ok(Number.isNaN(row[CPU_STEP.tilesPumpMs]), 'no pump: the textures bound is unmeasured');
  for (let i = 0; i < row.length; i++)
    if (!presentation.has(i) && i !== CPU_STEP.tilesPumpMs)
      assert.equal(row[i], 0, `step ${CPU_STEP_NAMES[i]} not executed`);
  assert.equal(timing.rowFilled, true, 'the held-frame row is deposited');
  assert.equal(timing.cpuSample, undefined, 'the detailed sample of another frame is dropped');
});

test('metrics of the redisplayed cut do not move', () => {
  const { rt, run, device } = tenue();
  holdWebgpuFrame(rt, device);
  const metrics = metricsOf(rt);
  assert.equal(metrics.frameHeld, true);
  assert.equal(metrics.clusters, 800, 'the redisplayed cut is the same');
  assert.equal(metrics.selectedTriangles, 123456);
  assert.equal(metrics.frustumRejected, 29987);
  assert.equal(metrics.lodLevel, 2);
  assert.equal(metrics.drawCalls, 1);
  assert.equal(metrics.submittedTriangles, 0);
  assert.equal(run.frame, 6, 'a frame was produced');
});

test('a cut page waiting for its bytes forbids holding the frame', () => {
  const { rt, device } = tenue();
  const pending = rt.services.cutPending as { count: number };
  assert.equal(holdWebgpuFrame(rt, device), true, 'a fully arrived cut holds');
  // The count is the one the cut difference holds: no list is reread here.
  pending.count = 1;
  assert.equal(holdWebgpuFrame(rt, device), false, 'a pending page can still open a hole');
  assert.equal(rt.run.frameHeld, false);
  pending.count = 0;
  assert.equal(holdWebgpuFrame(rt, device), true);
});

test('the shadow counters of a frame are published under their public names', () => {
  const { rt } = tenue();
  const lights = rt.lights as unknown as Record<string, unknown> & {
    plan: { counts: Record<string, number>; requests: { counts: Record<string, number> } };
  };
  lights.plan.requests.counts.requested = 211;
  lights.plan.counts.cachedPages = 205;
  lights.plan.counts.poolPages = 311;
  lights.plan.counts.pendingPages = 6;
  lights.shadowPages = 6;
  lights.lightRuns = 2;
  lights.cull = { counts: { counts: () => ({ frame: 40, regions: 6, kept: 77 }) } };
  assert.deepEqual([metricsOf(rt).shadowPoolBytes, metricsOf(rt).shadowPoolLayers], [null, null]);
  (lights.plan as unknown as { pool: object }).pool = { refetched: 0, layers: 2 };
  lights.shadows = { texture: {}, allocationBytes: 700 };
  lights.staticLayer = { bytes: 300 };
  const metrics = metricsOf(rt);
  assert.deepEqual([metrics.shadowPoolBytes, metrics.shadowPoolLayers], [1000, 2], 'once sized');
  assert.deepEqual(
    [
      metrics.shadowPagesRequested,
      metrics.shadowPagesCached,
      metrics.shadowPoolPages,
      metrics.shadowPagesDrawn,
      metrics.shadowPagesPending,
      metrics.shadowLightCuts,
      metrics.shadowCastersKept,
    ],
    [211, 205, 311, 6, 6, 2, 77],
  );
});
