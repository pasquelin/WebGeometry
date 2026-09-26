import { sharedGpuDevice } from '../gpu/core/sessionHandle.ts';
import { COVERAGE_CUT_WGSL, COVERAGE_PICK_WGSL, COVERAGE_SCALE_WGSL } from './coverageRule.ts';
import { levelSize } from './tiles.ts';

/** Bytes of one level's 256 bins. */
export const LEVEL_BIN_BYTES = 1024;

/**
 * The counts of the coverage rule (docs/FORMAT.md, "Coverage-preserving alpha"): `count` files the
 * four filtered samples of each texel's square (`cutBin`) — its alpha bytes level 0's own, a
 * level's medians from the one above — in its level's 256 bins, through a workgroup's own 256;
 * `choose` then picks that level's `t`, one thread, and leaves it in bin 0, which it never reads
 * (`t >= 1`). `level`: the source's extent, `C`, `t`, then level
 * 0's extent and the level.
 */
export const COVERAGE_WGSL = `
 @group(0) @binding(0) var source:texture_2d<f32>;
 struct Level{extent:vec4u,base:vec4u}
 @group(0) @binding(1) var<uniform> level:Level;
 @group(0) @binding(2) var<storage,read_write> cover:array<atomic<u32>>;
 fn binOf(t:u32)->u32{return atomicLoad(&cover[level.base.z*256u+t]);}
 ${COVERAGE_SCALE_WGSL}
 ${COVERAGE_PICK_WGSL}
 ${COVERAGE_CUT_WGSL}
 fn sizeOf(k:u32)->vec2u{return max(level.base.xy>>vec2u(k),vec2u(1u));}
 fn alphaAt(q:vec2u)->u32{
  let k=level.base.z;let p=vec2i(min(q,sizeOf(k)-vec2u(1u)));
  if(k==0u){return toByte(textureLoad(source,p,0).w);}
  let s=p*2;let hi=vec2i(level.extent.xy)-vec2i(1);
  return median(vec4f(textureLoad(source,min(s,hi),0).w,textureLoad(source,min(s+vec2i(1,0),hi),0).w,
   textureLoad(source,min(s+vec2i(0,1),hi),0).w,textureLoad(source,min(s+vec2i(1,1),hi),0).w));
 }
 var<workgroup> tally:array<atomic<u32>,256>;
 @compute @workgroup_size(8,8) fn count(@builtin(global_invocation_id) id:vec3u,@builtin(local_invocation_index) i:u32){
  let k=level.base.z;
  if(all(id.xy<sizeOf(k))){
   let q=id.xy;
   let a=vec4u(alphaAt(q),alphaAt(q+vec2u(1u,0u)),alphaAt(q+vec2u(0u,1u)),alphaAt(q+vec2u(1u,1u)));
   for(var s=0u;s<4u;s++){atomicAdd(&tally[cutBin(a,s,level.extent.z)],1u);}
  }
  // Foliage lands nearly every texel in two bins: the workgroup counts apart, then adds its own
  // bins once each, not one device atomic per texel on the same two words.
  workgroupBarrier();
  for(var b=i;b<256u;b+=64u){let n=atomicLoad(&tally[b]);if(n>0u){atomicAdd(&cover[k*256u+b],n);}}
 }
 @compute @workgroup_size(1) fn choose(){
  let c=level.extent.z;var covered=0u;
  for(var b=c;b<256u;b++){covered+=atomicLoad(&cover[b]);}
  let n0=sizeOf(0u);let nk=sizeOf(level.base.z);
  atomicStore(&cover[level.base.z*256u],pick(c,covered,vec2u(n0.x*n0.y,nk.x*nk.y)));
 }`;

type CoverageProgram = {
  layout: GPUBindGroupLayout;
  count: GPUComputePipeline;
  pick: GPUComputePipeline;
};
const programs = new WeakMap<GPUDevice, CoverageProgram>();

function coverageProgram(device: GPUDevice): CoverageProgram {
  const held = programs.get(device);
  if (held) return held;
  const visibility = GPUShaderStage.COMPUTE;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility, texture: { sampleType: 'float' } },
      { binding: 1, visibility, buffer: { type: 'uniform' } },
      { binding: 2, visibility, buffer: { type: 'storage' } },
    ],
  });
  const module = device.createShaderModule({ code: COVERAGE_WGSL }),
    pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipeline = (entryPoint: string) =>
    device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
  const built = { layout, count: pipeline('count'), pick: pipeline('choose') };
  programs.set(device, built);
  return built;
}

/** What a chain's counts read: its size, its levels' views, the uniform blocks of
 *  `generateMaterialMips`, one per level, and the device's bins, cleared. */
export type CoverageChain = {
  width: number;
  height: number;
  views: GPUTextureView[];
  uniforms: GPUBuffer;
  stride: number;
  bins: GPUBuffer;
};

/** Counts level `level` of `chain` (level 0 first, before level 1) and copies its `t` into the
 *  level's uniform block, the one its reduction then scales by. */
export function countCoverage(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  chain: CoverageChain,
  level: number,
) {
  const { layout, count, pick } = coverageProgram(sharedGpuDevice(device));
  const { width, height, views, uniforms, stride, bins } = chain;
  const group = (block: number, source: number) =>
    device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: views[source] },
        { binding: 1, resource: { buffer: uniforms, offset: block * stride, size: 32 } },
        { binding: 2, resource: { buffer: bins } },
      ],
    });
  const pass = encoder.beginComputePass();
  pass.setPipeline(count);
  const dispatch = ([w, h]: [number, number]) =>
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
  if (level === 1) {
    pass.setBindGroup(0, group(0, 0));
    dispatch([width, height]);
  }
  pass.setBindGroup(0, group(level, level - 1));
  dispatch(levelSize(width, height, level));
  pass.setPipeline(pick);
  pass.dispatchWorkgroups(1);
  pass.end();
  // `t` lands in the block's fourth word, the `extent.w` its reduction scales by.
  encoder.copyBufferToBuffer(bins, level * LEVEL_BIN_BYTES, uniforms, level * stride + 12, 4);
}
