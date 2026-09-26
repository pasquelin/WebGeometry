import { DAG_SELECTION_SHADER } from './shader/shader.ts';
import { DAG_BINDING, dagBindEntries } from './shader/bindings.ts';
import { namedBufferEntries } from '../core/computeBindings.ts';
import { LEVEL_QUEUES } from './shader/levelWgsl.ts';
import { withScreenErrorVariant } from './shader/error.ts';
import { screenErrorVariant } from '../../../../sdk-core/src/index.ts';
import { validated } from '../core/errorScope.ts';
import { shaderFailed } from '../core/shaderModule.ts';

type DagBuffers = {
  clusters: GPUBuffer;
  nodes: GPUBuffer;
  uniforms: GPUBuffer;
  flags: GPUBuffer;
  output: GPUBuffer;
  work: GPUBuffer;
  worlds: GPUBuffer;
  frames: GPUBuffer;
  pageCones: GPUBuffer;
};

/** The selection stages and their bind group, under one validation scope. */
export function createDagPipeline(device: GPUDevice, buffers: DagBuffers) {
  const { clusters, nodes, uniforms, flags, output, work, worlds, frames, pageCones } = buffers;
  return validated(device, async () => {
    const layout = device.createBindGroupLayout({ entries: dagBindEntries() });
    // The screen-error variant is frozen at shader compile: it no longer changes from
    // session open to session close, and the default text is rendered character for
    // character (`withScreenErrorVariant`).
    const module = device.createShaderModule({
      code: withScreenErrorVariant(DAG_SELECTION_SHADER, screenErrorVariant()),
    });
    if (await shaderFailed(module)) return undefined;
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const stage = (entryPoint: string) =>
      device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
    const preparePipeline = stage('dagPrepare'),
      clearDrawnPipeline = stage('dagClearDrawn');
    const levelPipelines = Array.from({ length: LEVEL_QUEUES }, (_, q) => stage(`dagLevel${q}`));
    const wantedPipeline = stage('dagWanted'),
      maskPipeline = stage('dagMask');
    const drawPrefixPipeline = stage('dagDrawPrefix'),
      drawScatterPipeline = stage('dagDrawScatter'),
      viewOffsetsPipeline = stage('dagViewOffsets'),
      requestSortPipeline = stage('dagSortRequests');
    const bindGroup = device.createBindGroup({
      layout,
      entries: namedBufferEntries(DAG_BINDING, {
        clusters: { buffer: clusters },
        nodes: { buffer: nodes },
        views: { buffer: uniforms },
        flags: { buffer: flags },
        out: { buffer: output },
        work: { buffer: work },
        worlds: { buffer: worlds },
        frames: { buffer: frames },
        cold: { buffer: pageCones },
      }),
    });
    return {
      /** Bind layout, returned with the stages: the dispatch bench mounts the previous
       *  cut on EXACTLY this one, instead of retyping a fourth copy. */
      layout,
      preparePipeline,
      clearDrawnPipeline,
      levelPipelines,
      wantedPipeline,
      maskPipeline,
      drawPrefixPipeline,
      drawScatterPipeline,
      viewOffsetsPipeline,
      requestSortPipeline,
      bindGroup,
    };
  });
}
