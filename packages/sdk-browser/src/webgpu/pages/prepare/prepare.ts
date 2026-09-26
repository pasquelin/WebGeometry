import { createDeferredLighting } from '../../../lighting/deferred/deferred.ts';
import { prepareTemporalAntialiasing } from '../../../taa/prepare.ts';
import { createSceneLightContractBuffer } from '../state/lightBuffer.ts';
import { prepareWebgpuPresentation } from '../../frame/presentationSetup.ts';
import { createWebgpuPagesPipelines } from './pipelines.ts';
import { ensureWebgpuPositionBuffer } from '../../core/positions.ts';
import { prepareWebgpuGeometry } from '../../core/geometryPrepare.ts';
import { prepareWebgpuBlend } from '../../blend/prepare.ts';
import { createTransparentTable } from '../../transparent/table.ts';
import { prepareBlendResources } from '../../blend/resources.ts';
import { createTransparentCompaction } from '../../transparent/compact.ts';
import { UNIFORM_STRIDE } from '../../blend/uniforms.ts';
import { VOLUME_WORDS, createVolumeBuffer } from '../../transparent/transmission.ts';
import { createGpuDagSelection, packDagSelection } from '../../../gpu/dag/selection.ts';
import { prepareCones } from './cones.ts';
import { grantFrameTargets } from './targetGrant.ts';
import { ensureUniform } from './pipelineFor.ts';
import { dropVis, grantCapability } from '../io/drops.ts';
import { throwIfStopped } from '../io/lost.ts';
import { prepareWebgpuTextures } from './textures.ts';
import { prepareWebgpuVisibility } from './visibility.ts';
import { prepareDirectLights } from './lights.ts';
import { grantWebgpuPagesCache } from './cache.ts';
import { prepareGpuTiming } from './timing.ts';
import { reserveRootBoxes } from '../../../math/batchBoxes.ts';
import { type WebgpuPagesRuntime } from '../runtime.ts';

/** The backend's preparation on its session's handle: its timer, every resource, then its root
 *  world boxes. */
export async function prepareWebgpuBackend(rt: WebgpuPagesRuntime, device: GPUDevice) {
  // A first claim hears of a device already lost a microtask later (`claimGpuDevice` has already
  // listened to `device.lost`): one tick, no listener of its own, and nothing is built.
  await undefined;
  throwIfStopped(rt);
  prepareGpuTiming(rt, device);
  await prepareWebgpuPages(rt, device);
  // Root world boxes last: linear memory no longer grows behind them, nor a node move.
  rt.context.preparationStep?.('root boxes');
  rt.layout.rootBoxes = await reserveRootBoxes(rt.layout.selectionRoots);
  throwIfStopped(rt);
}

/** Builds every GPU resource an image needs, once; `gpuDevice` is then kept as `gpu.device`. A
 *  backend closed, or a device lost, meanwhile starts no further step: what a step has returned is
 *  kept on the runtime, and the teardown releases it. */
export async function prepareWebgpuPages(rt: WebgpuPagesRuntime, gpuDevice: GPUDevice) {
  const { gpu, vis, run, context, diag, capabilities, blendState, services } = rt,
    { allPages, blendCopies, scene, cap } = rt.setup,
    { packedPages, selectionRoots, rows } = rt.layout;
  const step = <T>(name: string, work: () => Promise<T>) => {
    throwIfStopped(rt);
    rt.context.preparationStep?.(name);
    return work();
  };
  const lightBuffer = createSceneLightContractBuffer((gpu.device = gpuDevice), rt.lights.store);
  rt.lights.buffer = lightBuffer;
  // No more light written into the scene, on either side: opaques and transparents read the same
  // declared-light buffer, with the same shadows and the same exposure (P6).
  diag.engineDiagnostic('scene-lighting', 'Scene lights active', {
    version: 1,
    contractLights: rt.lights.store.count,
    sceneGraphLights: false,
    implicitAmbient: false,
    shadows: false,
    globalIllumination: false,
  });
  // The contract program finishes compiling between two images: its arrival is a new resource, or
  // the held image would keep presenting raw albedo. The two programs compile side by side.
  // Both are awaited, and each kept as it is built, before a failure of either goes up.
  const programs = await step('lighting and antialiasing programs', () =>
    Promise.allSettled([
      createDeferredLighting(gpuDevice, () => run.gate.resourcesChanged()),
      prepareTemporalAntialiasing(rt, gpuDevice),
    ]),
  );
  const [deferred] = programs;
  if (deferred.status === 'fulfilled') gpu.deferred = deferred.value;
  for (const program of programs) if (program.status === 'rejected') throw program.reason;
  gpu.presenter = prepareWebgpuPresentation(gpuDevice, context.gpuCanvas);
  if (gpu.presenter) grantCapability(capabilities, 'direct WebGPU present');
  diag.engineDiagnostic('gpu-presentation', 'GPU presentation initialised', {
    mode: context.gpuCanvas
      ? 'direct-canvas'
      : gpu.presenter
        ? 'gpu-canvas-webgl-composition'
        : 'texture-only',
    imageReadbackDuringRender: false,
  });
  ({
    bindGroupLayout: gpu.bindGroupLayout,
    pipelineBack: gpu.pipelineBack,
    pipelineBackCw: gpu.pipelineBackCw,
    pipelineNone: gpu.pipelineNone,
    pipelineBlend: gpu.pipelineBlend,
  } = createWebgpuPagesPipelines(gpuDevice, UNIFORM_STRIDE));
  // Only a cluster no quantized page covers still needs its primitive's float positions: what the
  // fallback draw reads for the others is the page in their pool slot.
  for (const rec of allPages)
    if (!rec.geometryPage)
      ensureWebgpuPositionBuffer(gpuDevice, rec.attributes, gpu.positionBuffers, gpu);
  for (let i = 0; i < packedPages.length; i++)
    rows.pagePositions[i] = gpu.positionBuffers.get(packedPages[i].attributes);
  // Fresh position buffers: rank sync starts over from the catalogue.
  rows.rowsRevision++;
  gpu.zeroUv = gpuDevice.createBuffer({
    size: 8,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  gpuDevice.queue.writeBuffer(gpu.zeroUv, 0, new Float32Array([0, 0]));
  blendState.transmissive = prepareWebgpuBlend(gpuDevice, blendCopies, gpu, blendState, scene);
  blendState.volumePacked = new Float32Array(blendState.transmissive * VOLUME_WORDS);
  gpu.volumeBuffer = createVolumeBuffer(gpuDevice, blendState.transmissive);
  // The transparent draw order is the scene's, settled here once: an image only picks survivors.
  const table = createTransparentTable(selectionRoots, packedPages, blendState.blendGpu);
  blendState.table = table;
  for (let i = 0; i < blendState.table.pagedItems.length; i++)
    blendState.table.pagedItems[i].pagedIndex = i;
  blendState.compaction = await step('transparent compaction', () =>
    createTransparentCompaction(gpuDevice, table),
  );
  diag.engineDiagnostic('transparent-clusters', 'Transparent cluster table', {
    version: 1,
    items: blendState.table.pagedItems.length,
    clusters: blendState.table.length,
    maxVertexWords: blendState.table.maxVertexWords,
    gpuCompaction: !!blendState.compaction?.encode,
    transmissiveMeshes: blendState.transmissive,
  });
  // The float geometry of what no page covers, concatenated once; then, every vertex buffer
  // allocated, the geometry pool is drawn from what they leave of its budget. A concatenation that
  // fails is a material failure, as the textures' are: the pool is still granted, the visibility
  // buffer dropped below.
  throwIfStopped(rt);
  vis.geometryBlocks.clear();
  let geometryFailure: { error: unknown } | undefined;
  try {
    ({
      concatPos: vis.concatPos,
      concatUv: vis.concatUv,
      concatNrm: vis.concatNrm,
    } = prepareWebgpuGeometry(gpuDevice, allPages, vis.geometryBlocks));
  } catch (error) {
    geometryFailure = { error };
  }
  await grantWebgpuPagesCache(rt, gpuDevice);
  await grantFrameTargets(rt, gpuDevice);
  ensureUniform(rt, gpuDevice, cap);
  try {
    if (geometryFailure) throw geometryFailure.error;
    await step('textures', () => prepareWebgpuTextures(rt, gpuDevice));
    // Item rows cite atlas layers: they are therefore mounted AFTER the textures.
    await step('blend resources', () => prepareBlendResources(rt, gpuDevice));
    await step('visibility programs', () => prepareWebgpuVisibility(rt, gpuDevice));
  } catch (error) {
    throwIfStopped(rt); // A close or a loss is no material failure.
    diag.diagnosticFailure('material-pipeline-failed', error);
    dropVis(rt);
  }
  if (blendState.blendGpu.length && !vis.blendPipelines) dropVis(rt);
  if (context.gpuCanvas && !vis.visEnabled) throw new Error('WEBGPU_MATERIAL_PIPELINE_UNAVAILABLE');
  if (context.gpuCanvas && blendState.blendGpu.length && !vis.blendPipelines)
    throw new Error('WEBGPU_FORWARD_MATERIAL_UNAVAILABLE');
  await step('direct lights', () => prepareDirectLights(rt, gpuDevice));
  prepareCones(rt);
  // Every cluster carries its own error band, so the GPU cut is one thread per cluster.
  if (vis.gpuDraw && selectionRoots.length) {
    run.gpuSelection = await step('GPU cut', () =>
      createGpuDagSelection(gpuDevice, packDagSelection(selectionRoots), {
        residentCut: true,
        diagnosticGpuVariant: rt.context.diagnosticGpuVariant,
      }),
    );
    // The GPU has just received ABSOLUTE world matrices: no render origin is posted there yet, and
    // the first image will bring them back to the eye wherever it is then.
    run.worldUploadOrigin.fill(NaN);
  }
  capabilities.gpuDriven = !!run.gpuSelection;
  await step('coverage bootstrap', () => services.bootstrapState.ensure());
  diag.engineDiagnostic('render-capabilities', 'Render paths ready', {
    surfaceVersion: gpu.surfaces?.version ?? null,
    deferredLighting: !!gpu.deferred,
    directLightTiles: !!rt.lights.tiles,
    shadowAtlas: !!rt.lights.shadows,
    shadowUnavailable: rt.lights.shadowReason,
    bounceProxy: !!context.readSceneProxy,
    bounceWanted: rt.bounce.wanted,
    imageReadbackDuringRender: false,
    visibilityBuffer: vis.visEnabled,
    gpuSelection: !!run.gpuSelection,
    indirectDraw: !!vis.gpuDraw,
    hiz: !!vis.gpuHiz,
    temporalAntialiasing: !!gpu.temporal,
    // No vector target is rasterised: the temporal pass derives them from the visibility buffer and
    // the placement's previous pose.
    motionVectors: gpu.temporal ? 'derived' : false,
    unsupported: [...capabilities.unsupported],
  });
}
