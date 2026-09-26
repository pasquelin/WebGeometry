import {
  PARTICLE_FLOATS,
  type ParticlePool,
  type ParticleStep,
} from '../../../sdk-core/src/fluids/particles.ts';
import type { WebgpuPagesRuntime } from '../webgpu/pages/runtime.ts';
import { createCheckedShaderModule } from '../gpu/core/shaderModule.ts';
import { bounceGroup, bounceLayout } from '../bounce/bindings.ts';
import { anyMoving, createPoolStates, refuseAll, usedSlots } from './poolStates.ts';
import { createWebgpuParticleDraw, type DrawState } from './webgpuParticleDraw.ts';
import { DRAW_FLOATS } from './drawWords.ts';
import { viewProj } from '../webgpu/pages/helpers.ts';

/** The pass label the GPU timings name the particle step by (`passesGpu`). */
export const PARTICLES_PASS = 'Trillion3D particles';
/** Slots one workgroup steps. */
export const PARTICLE_WORKGROUP = 64;

/** One invocation per slot: the record the ring gives it this image replaces it, then a live
 *  particle moves, its position counted from the pool's origin; a dead one nobody emitted into
 *  is left as it is. */
export const PARTICLES_WGSL = /* wgsl */ `
struct Particle { position: vec4f, velocity: vec4f }
struct Step { acceleration: vec3f, dt: f32, first: u32, count: u32, capacity: u32, pad: u32 }
@group(0) @binding(0) var<uniform> step: Step;
@group(0) @binding(1) var<storage, read> staged: array<Particle>;
@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;
@compute @workgroup_size(${PARTICLE_WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= step.capacity) { return; }
  let k = (i + step.capacity - step.first) % step.capacity;
  var p = particles[i];
  if (k < step.count) { p = staged[k]; } else if (p.position.w >= p.velocity.w) { return; }
  if (p.position.w < p.velocity.w) {
    let velocity = p.velocity.xyz + step.acceleration * step.dt;
    p.velocity = vec4f(velocity, p.velocity.w);
    p.position = vec4f(p.position.xyz + velocity * step.dt, p.position.w + step.dt);
  }
  particles[i] = p;
}`;

/** The step uniform, the WGSL `Step`: acceleration and `dt`, then the ring's first slot, count
 *  and capacity. Made once; `write` rewrites it for one pool's step. */
export function createStepWords() {
  const buffer = new ArrayBuffer(32),
    floats = new Float32Array(buffer),
    uints = new Uint32Array(buffer);
  const write = (pool: ParticlePool, { first, count, dt }: Readonly<ParticleStep>) => {
    floats.set(pool.acceleration);
    floats[3] = dt;
    uints[4] = first;
    uints[5] = count;
    uints[6] = pool.capacity;
  };
  return { buffer, uints, write };
}

type PoolState = DrawState & { step: GPUBuffer; staged: GPUBuffer; group: GPUBindGroup };

/**
 * The WebGPU particle step: one compute pass, timed under `PARTICLES_PASS`, one dispatch per pool
 * that has records or time to take. A pool's state is one storage buffer made the first time it
 * is stepped; its records ride in a staging buffer of the pool's size, written up to the image's
 * count. The pipeline compiles in the background; until it arrives no pool is taken, so what they
 * stage waits. `fail` hears a pipeline that could not be made, and every pool is then `refused`.
 */
export function createWebgpuParticles(device: GPUDevice, fail: (error: unknown) => void) {
  const layout = bounceLayout(device, ['uniform', 'read-only-storage', 'storage']);
  let pipeline: GPUComputePipeline | null | undefined;
  createCheckedShaderModule(device, PARTICLES_WGSL, 'PARTICLES')
    .then((module) =>
      device.createComputePipelineAsync({
        label: PARTICLES_PASS,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'main' },
      }),
    )
    .then((made) => (pipeline = made))
    .catch((error) => ((pipeline = null), fail(error)));
  const words = createStepWords();
  const pass: GPUComputePassDescriptor = { label: PARTICLES_PASS };
  const buffer = (name: string, size: number, usage: number) =>
    device.createBuffer({ label: `${PARTICLES_PASS} ${name}`, size, usage });
  const made = createPoolStates<PoolState>(
    (pool) => {
      const { STORAGE, UNIFORM, COPY_DST } = GPUBufferUsage;
      const step = buffer('step', words.buffer.byteLength, UNIFORM | COPY_DST),
        staged = buffer('staging', pool.staging.byteLength, STORAGE | COPY_DST),
        state = buffer('state', pool.capacity * PARTICLE_FLOATS * 4, STORAGE),
        draw = buffer('draw', DRAW_FLOATS * 4, UNIFORM | COPY_DST),
        group = bounceGroup(device, layout, [step, staged, state]);
      return { step, staged, state, draw, group };
    },
    (kept) => [kept.step, kept.staged, kept.state, kept.draw].forEach((gone) => gone.destroy()),
  );
  const drawn = createWebgpuParticleDraw(device, made.peek, fail);
  return {
    /** Steps `pools` in `encoder`; returns the dispatches encoded. */
    run(pools: readonly ParticlePool[], encoder: GPUCommandEncoder) {
      if (pipeline === undefined) return 0;
      let computing: GPUComputePassEncoder | undefined,
        dispatches = 0;
      for (const pool of pools) {
        pool.refused = !pipeline || drawn.refused();
        const step = pool.flush(),
          { count } = step;
        if (!pipeline || pool.refused || (!count && !step.dt)) continue;
        const kept = made.of(pool);
        words.write(pool, step);
        device.queue.writeBuffer(kept.step, 0, words.buffer);
        if (count)
          device.queue.writeBuffer(kept.staged, 0, pool.staging, 0, count * PARTICLE_FLOATS);
        if (!computing) {
          computing = encoder.beginComputePass(pass);
          computing.setPipeline(pipeline);
        }
        computing.setBindGroup(0, kept.group);
        computing.dispatchWorkgroups(Math.ceil(usedSlots(pool) / PARTICLE_WORKGROUP));
        dispatches++;
      }
      computing?.end();
      made.keep(pools);
      return dispatches;
    },
    draw: drawn.draw,
    dispose: made.dispose,
  };
}

export type WebgpuParticles = ReturnType<typeof createWebgpuParticles>;

/** True while one of the world's pools moves: the image changes, and is not held. */
export const particlesMoved = (rt: WebgpuPagesRuntime) => anyMoving(rt.context.particles);

/** The world's pools on this image, stepped in the image's command buffer ahead of its
 *  transparent stage, which draws them (#755). */
export function encodeParticles(
  rt: WebgpuPagesRuntime,
  device: GPUDevice,
  encoder: GPUCommandEncoder,
) {
  const pools = rt.context.particles;
  // Once made, the step runs with no pool left too: it gives a released pool's buffers back.
  if (!pools || (!pools.length && !rt.gpu.particles)) return;
  if (!rt.vis.visEnabled) {
    // A capability refusal, told once like WebGL2's (`particlesRefused`); the session goes on.
    if (refuseAll(pools))
      rt.context.particlesRefused?.(
        'PARTICLES_UNSUPPORTED: particles draw on the visibility buffer',
      );
    return;
  }
  rt.gpu.particles ??= createWebgpuParticles(device, (error) =>
    rt.diag.diagnosticFailure('particles-unavailable', error),
  );
  rt.run.gpuComputeDispatches += rt.gpu.particles.run(pools, encoder);
}

/** The world's stepped pools drawn over the lit image and its transparents, in beauty only. */
export function drawParticles(rt: WebgpuPagesRuntime, encoder: GPUCommandEncoder) {
  const { run } = rt,
    { hdrView, depthView, particles } = rt.gpu,
    pools = rt.context.particles;
  if (!pools || !particles || !hdrView || !depthView) return;
  if (run.diagnostic !== 'beauty' || !run.lastCamera) return;
  const { eye } = run.gate.cam;
  run.gpuDrawCalls += particles.draw(pools, encoder, hdrView, depthView, viewProj, eye);
}
