import { BOUNCE_SETTINGS, bounceBatchOf } from '../../../sdk-core/src/index.ts';
import { bounceGroup, bounceLayout } from './bindings.ts';
import {
  BOUNCE_SURFACE_PASS,
  BOUNCE_SURFACE_SHADER,
  SURFACE_WORKGROUP,
  surfaceCacheBytes,
  surfaceCacheTexels,
} from './surfaceWgsl.ts';
import type { GpuBounceProxy } from './proxy.ts';
import { createWebgpuBindIdentity } from '../webgpu/core/bindIdentity.ts';
import { createCheckedShaderModule } from '../gpu/core/shaderModule.ts';

/** What the cache pass binds: the grid, the proxy and its albedo, lights, frozen probes, the
 *  cache. The proxy is writable because its header carries `atomic` counters; this pass writes
 *  nothing there. */
const SURFACE_TYPES: (GPUBufferBindingType | null)[] = [
  'uniform',
  'storage',
  'read-only-storage',
  'read-only-storage',
  'read-only-storage',
  'storage',
  'uniform',
];

export type GpuBounceSurface = Awaited<ReturnType<typeof createGpuBounceSurface>>;

/**
 * Proxy surface cache and the pass that sweeps it (LR5).
 *
 * One cell per triangle and per face, updated on a fixed cell budget per frame. The sweep
 * restarts as soon as a light changes — the same invalidation as a shadow map — and stops by
 * itself when nothing moves: a still scene does not encode this pass.
 */
export async function createGpuBounceSurface(
  device: GPUDevice,
  proxy: GpuBounceProxy,
  lights: () => GPUBuffer,
  grid: { uniform: GPUBuffer; snapshot: GPUBuffer },
) {
  const texels = surfaceCacheTexels(proxy.triangleCount);
  const bytes = surfaceCacheBytes(proxy.triangleCount);
  const buffer = device.createBuffer({
    label: 'Trillion3D bounce surface cache v1',
    size: bytes,
    usage: GPUBufferUsage.STORAGE,
  });
  const span = device.createBuffer({
    label: 'Trillion3D bounce surface span v1',
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const release = () => {
    buffer.destroy();
    span.destroy();
  };
  const module = await createCheckedShaderModule(
    device,
    BOUNCE_SURFACE_SHADER,
    'BOUNCE_SURFACE_SHADER',
  );
  const layout = bounceLayout(device, SURFACE_TYPES);
  let pipeline: GPUComputePipeline;
  try {
    pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'updateSurface' },
    });
  } catch (error) {
    release();
    throw error;
  }
  const bound = createWebgpuBindIdentity();
  let group: GPUBindGroup | undefined;
  /** The group, made again when the light buffer it names was replaced. */
  const groupOf = (current: GPUBuffer) => {
    bound.next[0] = current;
    if (bound.moved() || !group)
      group = bounceGroup(device, layout, [
        grid.uniform,
        proxy.buffer,
        proxy.albedo,
        current,
        grid.snapshot,
        buffer,
        span,
      ]);
    return group;
  };
  const ceiling = Math.min(BOUNCE_SETTINGS.surfaceTexelsPerFrame, texels);
  const words = new Uint32Array(4);
  let cursor = 0,
    sweeps = 0,
    updated = 0,
    batch = ceiling;
  return {
    buffer,
    texels,
    /** What the cache occupies in GPU memory, published in the diagnostic. */
    bytes,
    /** Frames of a full cache sweep at the current batch: the other half of the lag. */
    get sweepFrames() {
      return Math.max(1, Math.ceil(texels / Math.max(1, batch)));
    },
    /** Full sweeps since the last invalidation. */
    get sweeps() {
      return sweeps;
    },
    /** Cells updated by the last encoded frame. */
    get lastTexels() {
      return updated;
    },
    /** A light changed: the whole cache is stale, the sweep resumes where it was.
     *  Rewinding the cursor would only redo the same cells every frame of a moving light. */
    restart() {
      sweeps = 0;
    },
    /**
     * Encodes a cell batch whose size is the fraction of the ceiling the millisecond budget
     * kept. The pass carries its label: it is measured separately.
     */
    encode(encoder: GPUCommandEncoder, load: number) {
      batch = bounceBatchOf(ceiling, load);
      words[0] = cursor;
      words[1] = batch;
      device.queue.writeBuffer(span, 0, words);
      const pass = encoder.beginComputePass({ label: BOUNCE_SURFACE_PASS });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, groupOf(lights()));
      pass.dispatchWorkgroups(Math.ceil(batch / SURFACE_WORKGROUP), 1, 1);
      pass.end();
      updated = batch;
      cursor += batch;
      if (cursor >= texels) {
        cursor = 0;
        sweeps++;
      }
    },
    dispose: release,
  };
}
