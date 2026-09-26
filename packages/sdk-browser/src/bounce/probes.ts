import {
  BOUNCE_PROBES_PER_FRAME,
  BOUNCE_SETTINGS,
  bounceBatchOf,
  createBounceBudget,
  createBounceCascades,
  createBounceOccupancy,
  type SceneProxy,
} from '../../../sdk-core/src/index.ts';
import { bounceGroup, bounceLayout } from './bindings.ts';
import { bounceProbeBytes, ensureBounceFits } from './limits.ts';
import { BOUNCE_PROBE_PASS, BOUNCE_PROBE_SHADER } from './probeWgsl.ts';
import { createBounceSchedule } from './schedule.ts';
import { createBounceUniform } from './uniform.ts';
import { createGpuBounceProxy } from './proxy.ts';
import { createGpuBounceSurface, type GpuBounceSurface } from './surface.ts';
import { createCheckedShaderModule } from '../gpu/core/shaderModule.ts';

/** What the probe pass binds: the cascades, the proxy and its albedo, the frame queue, frozen
 *  probes, new ones, the cache. Lights are no longer there: the cache has evaluated them per
 *  cell. The proxy is writable because its header carries `atomic` counters; this pass writes
 *  nothing there. */
const PROBE_TYPES: (GPUBufferBindingType | null)[] = [
  'uniform',
  'storage',
  'read-only-storage',
  'read-only-storage',
  'read-only-storage',
  'storage',
  'read-only-storage',
];

export type GpuBounceProbes = Awaited<ReturnType<typeof createGpuBounceProbes>>;

/**
 * Irradiance probe cascades, the surface cache, and the two passes that sweep them.
 *
 * The budget is a **duration**, not a count (X4, LR2): the host gives a target in milliseconds,
 * the « Bounce » stage timer compares it to what the frame cost, and the fraction of the published
 * ceilings the next frame will encode rises or falls. Cadence never yields; it is convergence
 * that stretches. When nothing changes, neither pass is encoded: a still scene pays nothing.
 */
export async function createGpuBounceProbes(
  device: GPUDevice,
  proxy: SceneProxy,
  /** The declared-light buffer, read at each encode: it is replaced when the scene outgrows it. */
  lights: () => GPUBuffer,
  budgetMs: number,
) {
  const cascades = createBounceCascades(proxy.bounds);
  const occupancy = createBounceOccupancy(proxy, cascades);
  const schedule = createBounceSchedule(cascades, occupancy);
  const budget = createBounceBudget(budgetMs);
  const probeBytes = bounceProbeBytes(cascades.probes);
  // Nothing is created until everything fits: a single binding above a device limit would lose
  // the device on the first frame, and the refusal names which one.
  ensureBounceFits(device, proxy, probeBytes, schedule.queue.byteLength);
  const resident = createGpuBounceProxy(device, proxy);
  const uniform = createBounceUniform(device, cascades);
  const queue = device.createBuffer({
    label: 'Trillion3D bounce probe queue v1',
    size: schedule.queue.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const probes = device.createBuffer({
    label: 'Trillion3D bounce probes v2',
    size: probeBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });
  // Copy both passes read: frozen before them, so a higher-order bounce always sees the previous
  // frame's full cascades, never a neighbour half-written.
  const snapshot = device.createBuffer({
    label: 'Trillion3D bounce probes snapshot v2',
    size: probeBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const release = () => {
    queue.destroy();
    uniform.dispose();
    probes.destroy();
    snapshot.destroy();
    resident.dispose();
  };
  let surface: GpuBounceSurface;
  let pipeline: GPUComputePipeline;
  let group: GPUBindGroup;
  try {
    surface = await createGpuBounceSurface(device, resident, lights, {
      uniform: uniform.buffer,
      snapshot,
    });
    const module = await createCheckedShaderModule(device, BOUNCE_PROBE_SHADER, 'BOUNCE_PROBE');
    const layout = bounceLayout(device, PROBE_TYPES);
    pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'updateProbes' },
    });
    group = bounceGroup(device, layout, [
      uniform.buffer,
      resident.buffer,
      resident.albedo,
      queue,
      snapshot,
      probes,
      surface.buffer,
    ]);
  } catch (error) {
    release();
    throw error;
  }
  let generation = 1,
    frame = 0,
    updates = 0;
  /** Full rounds: a cascade sweep and a cache sweep, the slower of the two. */
  const rounds = () => Math.min(schedule.sweeps, surface.sweeps);
  /** True while the bounce series is not closed: beyond that, nothing more is encoded. */
  const working = () => rounds() < BOUNCE_SETTINGS.settledSweeps;
  /** Frame probes: the fraction of the published ceiling the millisecond budget holds. */
  const batch = () => bounceBatchOf(BOUNCE_PROBES_PER_FRAME, budget.load);
  return {
    cascades,
    occupancy,
    budget,
    surface,
    proxy: resident,
    uniform: uniform.buffer,
    probes,
    /** Frames of a full round, measured: that is the bound on convergence lag. */
    get sweepFrames() {
      return Math.max(schedule.sweepFrames, surface.sweepFrames, 1);
    },
    /** Probes the occupancy map keeps at the finest level, on its cells. */
    activeProbes: occupancy.marked,
    /** Probes updated by the last encoded frame, and rays they launched. */
    get lastProbes() {
      return updates;
    },
    get lastRays() {
      return updates * BOUNCE_SETTINGS.raysPerProbe;
    },
    /** True while the bounce series is not closed: beyond that, nothing more is encoded. */
    get working() {
      return working();
    },
    /** Stage timer, as the per-stage profile recorded it. `null` is not zero. */
    observeGpuMs(ms: number | null) {
      budget.observe(ms);
    },
    setIrradianceView: uniform.setIrradianceView,
    /** A light changed: sweeps restart, sleeping probes wake. */
    restart() {
      generation++;
      schedule.restart();
      surface.restart();
    },
    /**
     * Encodes a cache round then a probe batch. Returns `false` when there was nothing to do:
     * the scene is still, the series is closed, and the « Bounce » stage is « unmeasured ».
     */
    encode(encoder: GPUCommandEncoder, lightsActive: number, viewpoint: ArrayLike<number>) {
      updates = 0;
      // A cascade that slides brings in new cells: that is work, like a light that moves. A still
      // camera slides nobody and therefore restarts nothing.
      if (cascades.follow(viewpoint)) schedule.restart();
      if (!cascades.probes || !lightsActive || !working()) return false;
      frame++;
      const groups = schedule.plan(batch());
      if (groups) device.queue.writeBuffer(queue, 0, schedule.queue, 0, groups);
      uniform.write(generation, groups, frame);
      encoder.copyBufferToBuffer(probes, 0, snapshot, 0, probeBytes);
      surface.encode(encoder, budget.load);
      // An empty queue — no scene cell deserves a probe — does not encode the pass: the surface
      // cache keeps sweeping, which depends on no probe.
      if (groups) {
        const pass = encoder.beginComputePass({ label: BOUNCE_PROBE_PASS });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        // One workgroup per probe: a probe's rays share its threads.
        pass.dispatchWorkgroups(groups, 1, 1);
        pass.end();
      }
      updates = groups;
      return true;
    },
    dispose() {
      surface.dispose();
      release();
    },
  };
}
