// #35: the transmittance layer's textures, bytes, pipelines and pass, at half the pool's resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SHADOW_TRANSMITTANCE_PASS,
  TRANSMITTANCE_BLEND,
  TRANSMITTANCE_CLEAR,
  createShadowTransmittance,
  shadowTransmittanceBytes,
} from './transmittance.ts';
import { DRAW_INDIRECT_STRIDE } from '../draw/draw.ts';
import { SHADOW_PAGE } from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { encodeTransmittance } from '../../webgpu/pages/render/encodeShadowPass.ts';
import { REGION_CLEAR, REGION_RESTORE, REGION_STATIC } from '../../webgpu/shadow/regions.ts';
import type { WebgpuPagesRuntime } from '../../webgpu/pages/runtime.ts';
import { installGpuGlobals } from '../../../../../tests/kit/gpu/globals.ts';

/** Every call an object receives, by name, in order. */
function recorder<T>() {
  const calls: Array<[string, unknown[]]> = [];
  // A method set on the object stands; any other is recorded and returns its first argument.
  const target = new Proxy({} as Record<string, unknown>, {
    get: (own, name: string) =>
      own[name] ?? ((...args: unknown[]) => (calls.push([name, args]), args[0])),
  });
  return { target: target as T, calls };
}

function created(poolSide: number) {
  installGpuGlobals();
  const device = recorder<GPUDevice>(),
    encoder = recorder<GPUCommandEncoder>();
  (encoder.target as unknown as { beginRenderPass: unknown }).beginRenderPass = (
    d: GPURenderPassDescriptor,
  ) => (encoder.calls.push(['beginRenderPass', [d]]), { end() {} });
  (device.target as unknown as { createTexture: unknown }).createTexture = (
    d: GPUTextureDescriptor,
  ) => (
    device.calls.push(['createTexture', [d]]),
    { createView: () => d, destroy() {}, depthOrArrayLayers: 1 }
  );
  const layer = createShadowTransmittance(
    device.target,
    {} as never,
    [{}, {}] as never,
    [{}] as never,
    poolSide,
    encoder.target,
  );
  const of = (name: string) => device.calls.filter(([n]) => n === name).map(([, [d]]) => d);
  return { layer, of, passes: encoder.calls.map(([, [d]]) => d as GPURenderPassDescriptor) };
}

test('the layer holds 8 bytes per 4 page texels: 128 MiB a layer of the pool', () => {
  const texels = (side: number) => (side * SHADOW_PAGE) ** 2;
  for (const side of [1, 2, 51, 64])
    assert.equal(shadowTransmittanceBytes(side), (texels(side) / 4) * 8);
  assert.equal(shadowTransmittanceBytes(64, 2), 2 * 128 * 2 ** 20);
  const { layer, of } = created(2);
  assert.equal(layer.bytes, shadowTransmittanceBytes(2));
  const textures = of('createTexture') as GPUTextureDescriptor[];
  assert.deepEqual(
    textures.map((t) => [t.format, ...(t.size as number[])]),
    [
      ['rgba8unorm', SHADOW_PAGE, SHADOW_PAGE, 1],
      ['depth32float', SHADOW_PAGE, SHADOW_PAGE, 1],
    ],
    'half the side of a pool of 2 pages',
  );
});

test('the layer starts with all the light and no translucent depth', () => {
  const [pass] = created(2).passes;
  const [colour] = pass.colorAttachments as GPURenderPassColorAttachment[];
  assert.deepEqual([colour.loadOp, colour.clearValue], ['clear', TRANSMITTANCE_CLEAR]);
  const depth = pass.depthStencilAttachment!;
  assert.deepEqual([depth.depthLoadOp, depth.depthClearValue], ['clear', 0]);
});

test('depth-only then colour-only draws of the blended rows, the opaque depth read beside', () => {
  const { layer, of } = created(2);
  const p = (x: unknown) => x as GPURenderPipelineDescriptor;
  const [clear, depth, blend] = [p(layer.clear), p(layer.depth), p(layer.blend)];
  assert.deepEqual(
    [clear, depth, blend].map((d) => [d.vertex.entryPoint, d.fragment!.entryPoint]),
    [
      ['shadow_clear_vs', 'shadow_clear_fs'],
      ['shadow_blend_vs', 'shadow_blend_fs'],
      ['shadow_blend_vs', 'shadow_blend_fs'],
    ],
  );
  assert.deepEqual(depth.depthStencil, {
    format: 'depth32float',
    depthWriteEnabled: true,
    depthCompare: 'greater',
  });
  assert.equal([...depth.fragment!.targets][0]!.writeMask, 0, 'no colour from the depth draw');
  assert.deepEqual(blend.depthStencil, {
    format: 'depth32float',
    depthWriteEnabled: false,
    depthCompare: 'always',
  });
  assert.equal([...blend.fragment!.targets][0]!.blend, TRANSMITTANCE_BLEND);
  assert.deepEqual(clear.depthStencil!.depthWriteEnabled, true, 'a page clear resets its depth');
  const [opaque] = of('createBindGroupLayout') as GPUBindGroupLayoutDescriptor[];
  assert.deepEqual([...opaque.entries][0].texture, { sampleType: 'depth' });
});

/** The layer's pass over three regions — cleared, static, restored —, with or without blended
 *  casters: the calls its render pass received after `begin`, and the draw calls it counted. */
function encoded(casters: boolean) {
  const r = recorder<GPURenderPassEncoder>();
  const encoder = { beginRenderPass: (d: unknown) => (r.calls.push(['begin', [d]]), r.target) };
  const kept = {},
    indirect = {},
    key = [{}, {}, {}, {}, {}, kept, undefined];
  const starts = [REGION_CLEAR, REGION_STATIC, REGION_RESTORE];
  const rt = {
    vis: {
      visBindGroupLayout: {},
      concatPos: key[1],
      concatUv: key[2],
      pageTable: key[3],
      textures: { color: { views: key[4] } },
      mapsSampler: {},
      zeroFlags: {},
    },
    gpu: { cache: { buffer: key[0] } },
    run: { gpuDrawCalls: 0 },
    services: { blendCasters: { used: casters ? 1 : 0 } },
    lights: {
      cull: { kept, indirect },
      shadowGroupsKey: key,
      shadowGroups: ['g0', 'g1', 'g2'],
      shadows: { faceGroup: 'faces', faceStride: 256 },
      regions: {
        startOf: (i: number) => starts[i],
        x: (i: number) => 256 * i,
        y: () => 128,
        layer: () => 0,
      },
    },
  } as unknown as WebgpuPagesRuntime;
  const pool = { targets: [{}], depthTargets: [{}], opaqueGroups: ['opaque'] },
    layer = { clear: 'clear', depth: 'depth', blend: 'blend', ...pool };
  encodeTransmittance(rt, {} as GPUDevice, encoder as never, 3, layer as never, false);
  const [begin, ...calls] = r.calls;
  assert.equal((begin[1][0] as GPURenderPassDescriptor).label, SHADOW_TRANSMITTANCE_PASS);
  return { calls, draws: rt.run.gpuDrawCalls, indirect };
}

/** What region `i` of `encoded` receives: its half-size place, its groups, its clear. */
const half = SHADOW_PAGE / 2;
const cleared = (i: number) => [
  ['setViewport', [128 * i, 64, half, half, 0, 1]],
  ['setScissorRect', [128 * i, 64, half, half]],
  ['setBindGroup', [0, `g${i}`]],
  ['setBindGroup', [1, 'faces', [256 * i]]],
  ['setPipeline', ['clear']],
  ['draw', [3]],
];

test('the pass draws each page the pool drew at half its place, from a clear page', () => {
  const { calls, draws, indirect } = encoded(true);
  const region = (i: number) => [
    ...cleared(i),
    ['setPipeline', ['depth']],
    ['drawIndirect', [indirect, DRAW_INDIRECT_STRIDE * i]],
    ['setPipeline', ['blend']],
    ['drawIndirect', [indirect, DRAW_INDIRECT_STRIDE * i]],
  ];
  assert.deepEqual(calls, [
    ['setBindGroup', [2, 'opaque']],
    ...region(0),
    ...region(2),
    ['end', []],
  ]);
  assert.equal(draws, 6);
});

test('once no blended caster holds a row, a page is only cleared: no draw of the caster list', () => {
  const { calls, draws } = encoded(false);
  assert.deepEqual(calls, [
    ['setBindGroup', [2, 'opaque']],
    ...cleared(0),
    ...cleared(2),
    ['end', []],
  ]);
  assert.equal(draws, 2);
});
