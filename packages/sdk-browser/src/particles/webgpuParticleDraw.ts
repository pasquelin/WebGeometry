import { PARTICLE_BLENDS, type ParticlePool } from '../../../sdk-core/src/fluids/particles.ts';
import { createCheckedShaderModule } from '../gpu/core/shaderModule.ts';
import { buildRenderPipeline } from '../lighting/deferred/fullscreen.ts';
import { DISC_CORNERS, DRAW_FLOATS, drawOrder, writeDrawWords } from './drawWords.ts';
import { usedSlots } from './poolStates.ts';

/** The pass label the GPU timings name the particle draw by (`passesGpu`). */
export const PARTICLE_DRAW_PASS = 'Trillion3D particle draw';

/** Per slot, a disc facing the eye, fading with age, at its edge and near the scene's depth. */
export const PARTICLE_DRAW_WGSL = /* wgsl */ `
struct Particle { position: vec4f, velocity: vec4f }
struct Draw { clip: mat4x4f, unclip: mat4x4f, eye: vec3f, size: f32, color: vec4f, softness: f32 }
@group(0) @binding(0) var<uniform> draw: Draw;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;
@group(0) @binding(2) var depth: texture_depth_2d;
struct Out { @builtin(position) at: vec4f, @location(0) corner: vec2f, @location(1) local: vec3f, @location(2) life: f32 }
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> Out {
  let p = particles[i];
  var o: Out;
  o.at = vec4f(2, 2, 2, 1);
  if (!(p.position.w < p.velocity.w)) { return o; }
  var corners = array(${DISC_CORNERS});
  let toEye = normalize(draw.eye - p.position.xyz);
  let right = normalize(cross(select(vec3f(0, 1, 0), vec3f(1, 0, 0), abs(toEye.y) > 0.99), toEye));
  o.corner = corners[v];
  o.local = p.position.xyz + (right * o.corner.x + cross(toEye, right) * o.corner.y) * draw.size;
  o.at = draw.clip * vec4f(o.local, 1);
  o.life = 1 - p.position.w / p.velocity.w;
  return o;
}
@fragment fn fs(in: Out) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(depth));
  let ndc = vec2f(in.at.x / size.x * 2 - 1, 1 - in.at.y / size.y * 2);
  let scene = draw.unclip * vec4f(ndc, textureLoad(depth, vec2i(in.at.xy), 0), 1);
  let behind = distance(scene.xyz / scene.w, draw.eye) - distance(in.local, draw.eye);
  let soft = select(1.0, saturate(behind / draw.softness), abs(scene.w) > 1e-20);
  let k = saturate(1 - dot(in.corner, in.corner)) * soft * in.life * draw.color.a;
  return vec4f(draw.color.rgb, 1) * k;
}`;

/** What the draw keeps in a pool's step state: its words, its group and the depth it was made on. */
export type DrawState = {
  state: GPUBuffer;
  draw: GPUBuffer;
  drawn?: GPUBindGroup;
  depth?: GPUTextureView;
};

// Smoke covers colour and coverage alike; fire adds light and leaves the coverage.
const OVER = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } as const;
const BLENDS: Record<ParticlePool['blend'], GPUBlendState> = {
  additive: {
    color: { srcFactor: 'one', dstFactor: 'one' },
    alpha: { srcFactor: 'zero', dstFactor: 'one' },
  },
  premultiplied: { color: OVER, alpha: OVER },
};

/** The WebGPU particle draw: one pass over the lit image, one instanced draw per live pool, the
 *  opaque depth read for the soft edge. `fail` hears a pipeline not made; the step then refuses
 *  the pools (`refused`). */
export function createWebgpuParticleDraw(
  device: GPUDevice,
  stateOf: (pool: ParticlePool) => DrawState | undefined,
  fail: (error: unknown) => void,
) {
  const { VERTEX, FRAGMENT } = GPUShaderStage;
  const layout = device.createBindGroupLayout({
    label: PARTICLE_DRAW_PASS,
    entries: [
      { binding: 0, visibility: VERTEX | FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: FRAGMENT, texture: { sampleType: 'depth' } },
    ],
  });
  const pipelines: Partial<Record<ParticlePool['blend'], GPURenderPipeline>> = {};
  let failed = false;
  createCheckedShaderModule(device, PARTICLE_DRAW_WGSL, 'PARTICLE_DRAW')
    .then((module) => {
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
      return Promise.all(
        PARTICLE_BLENDS.map(async (blend) => {
          const targets: GPUColorTargetState[] = [{ format: 'rgba16float', blend: BLENDS[blend] }];
          pipelines[blend] = await buildRenderPipeline(device, {
            label: `${PARTICLE_DRAW_PASS} ${blend}`,
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vs' },
            fragment: { module, entryPoint: 'fs', targets },
          });
        }),
      );
    })
    .catch((error) => ((failed = true), fail(error)));
  const words = new Float32Array(DRAW_FLOATS),
    order: ParticlePool[] = [];
  /** The pool's group, made again only when the depth target changed. */
  const groupOf = (kept: DrawState, depth: GPUTextureView) => {
    if (kept.depth !== depth) {
      const buffers = [kept.draw, kept.state].map((buffer) => ({ buffer }));
      const entries = [...buffers, depth].map((resource, binding) => ({ binding, resource }));
      kept.drawn = device.createBindGroup({ label: PARTICLE_DRAW_PASS, layout, entries });
      kept.depth = depth;
    }
    return kept.drawn!;
  };
  return {
    /** Draws `pools` over `target` in `encoder`, seen through `viewProj` from `eye`, softened
     *  by `depth`; returns the draws encoded, none without a live particle. */
    draw(
      pools: readonly ParticlePool[],
      encoder: GPUCommandEncoder,
      target: GPUTextureView,
      depth: GPUTextureView,
      viewProj: ArrayLike<number>,
      eye: ArrayLike<number>,
    ) {
      if (failed) return 0;
      let pass: GPURenderPassEncoder | undefined,
        draws = 0;
      for (const pool of drawOrder(pools, eye, order)) {
        const pipeline = pipelines[pool.blend],
          kept = stateOf(pool);
        if (!pipeline || !kept) continue;
        writeDrawWords(words, pool, viewProj, eye);
        device.queue.writeBuffer(kept.draw, 0, words);
        pass ??= encoder.beginRenderPass({
          label: PARTICLE_DRAW_PASS,
          colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, groupOf(kept, depth));
        pass.draw(6, usedSlots(pool));
        draws++;
      }
      pass?.end();
      return draws;
    },
    refused: () => failed,
  };
}
