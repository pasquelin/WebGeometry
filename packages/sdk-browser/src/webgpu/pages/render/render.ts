import { sameHizView } from '../../../hiz/hiz.ts';
import { createEngineCamera, holdCameraWorld, type HostCamera } from '../../../camera/world.ts';
import { fallbackToCpuCut, invalidateTemporalPyramid } from '../io/drops.ts';
import { renderGpuCut } from './gpuCut.ts';
import { renderCpuCut } from './cpu.ts';
import { uploadWorlds } from './worldUpload.ts';
import { setWindingEpoch } from './winding.ts';
import { holdWebgpuFrame } from '../../frame/hold.ts';
import { sizeShadowPool } from '../../shadow/poolSize.ts';
import { requestFrameTargets } from '../prepare/targetGrant.ts';
import { pumpResidentTiles } from '../prepare/lightResources.ts';
import { refreshBlendWorlds } from '../../blend/worlds.ts';
import { refreshBlendScene } from '../../blend/resources.ts';
import type { WebgpuPagesRuntime } from '../runtime.ts';
import { followLiveTextures } from '../io/memory.ts';

/** Renders one image: refreshes the scene inputs a row depends on, then hands the frame to the GPU
 *  cut when it is available and to the CPU reference cut otherwise. */
export function renderWebgpuPages(rt: WebgpuPagesRuntime, camera: HostCamera, aspect?: number) {
  const { run, gpu, vis, capture, context, blendState } = rt,
    { source } = rt.setup,
    gpuDevice = gpu.device,
    { selectionRoots, rows } = rt.layout;
  if (capture.capturing && !capture.surfaceRenderAllowed) throw new Error('SURFACE_CAPTURE_BUSY');
  if (context.signal?.aborted) context.signal.throwIfAborted();
  if (run.lost) throw new Error('WEBGPU_LOST');
  if (!gpuDevice || !gpu.cache) throw new Error('WEBGPU_UNAVAILABLE');
  const marks = rt.timing.marks;
  marks.preStart = performance.now();
  run.lastCamera = camera;
  // Image entry: order and its guarantees live in `../../../frame/gateCore.ts`, which also copies the host
  // camera into the engine's — everything that follows only reads the latter. The list of nodes
  // the host can write is only built at a scene change, never per image — twelve instances of the
  // same model re-read that model once.
  run.gate.enterFrame(
    context,
    camera,
    run.motion,
    rt.setup.viewport,
    source,
    () => [...selectionRoots.map((root) => root.pages[0]), ...blendState.blendGpu],
    aspect,
  );
  sizeShadowPool(rt);
  // Targets that no longer fit the view are asked; the frame is held until granted.
  void requestFrameTargets(rt, gpuDevice);
  const pixelError = run.gate.pixelError,
    cam = run.gate.cam;
  // The atlases' records brought up to their host textures once for the image (#360, #361): a
  // sampling or a placement moved rewrites the texture's header, a resource change that releases a
  // held image. A filter rule switched on or off moves the resolve class of the pages that wear
  // the texture (`FLAG_SAMPLED`): their rows and the transparent records are written again.
  if (vis.textures?.followSampling()) {
    rows.tableEpoch++;
    refreshBlendScene(rt, gpuDevice);
  }
  followLiveTextures(rt);
  // Neither the scene, nor the view, nor the resources have moved, and nothing is in flight: the
  // previous image is this one. No CPU step is run below.
  if (holdWebgpuFrame(rt, gpuDevice)) return;
  run.diagnosticPixelError = pixelError;
  // Nothing is held by default: only adoption of an already-read readback declares it, and every
  // path that does not go through it — CPU cut, surface capture, pending image — remakes everything.
  run.cutHeld = false;
  setWindingEpoch(rows.tableEpoch);
  // What the previous image's feedback requested becomes resident, under the budgets. The pass
  // times itself on its budget clock — the one bound the textures stage reads —; the marks only
  // keep `worldMs` below to the world step alone.
  marks.gateEnd = performance.now();
  pumpResidentTiles(vis.textures, run.frame, run.textureConverging);
  marks.tilesEnd = performance.now();
  const worldsMoved = uploadWorlds(rt, cam);
  // A camera that moves invalidates the temporal pyramid, not the occluder half: the latter
  // only chooses the pass where a cluster is drawn, and this image's pyramid remains the sole
  // judge of what is withdrawn. The GPU partition still learns of the move: while the view
  // stands still, a row the test has kept is not sent back to the tested half — that is what
  // lets the halves converge under the antialiasing jitter, and an image be held.
  run.hizViewMoved = !sameHizView(run.previousHizView, cam);
  if (run.hizViewMoved) {
    invalidateTemporalPyramid(run);
    // The world pose is copied into the already-held camera: the same comparison, without a clone per image.
    run.previousHizView = holdCameraWorld(run.previousHizView ?? createEngineCamera(), cam);
  }
  marks.blendStart = performance.now();
  // A transparent item READS the world matrix of its source mesh: nothing is to be copied. Only
  // its world box, which is a computation, is remade — and only when the scene has changed matrices.
  if (worldsMoved && gpuDevice) {
    refreshBlendWorlds(blendState.blendGpu);
    // Records, boxes and the plan follow the scene, not the camera: it is here, and nowhere in
    // the image, that the transparent list is walked again.
    refreshBlendScene(rt, gpuDevice);
  }
  const cpuStart = performance.now();
  // No more scene light is packed per image: declared lamps live in a store that encoding only
  // pushes to the GPU if its revision has moved (P6). The CPU "Lights" step is therefore zero
  // because the work has disappeared, not because it is not measured.
  const lightsEnd = cpuStart;
  run.overBudget = false;
  run.submittedTriangles = 0;
  run.blendPagedTriangles = 0;
  run.blendUnpagedTriangles = 0;
  run.blendSubmittedTriangles = 0;
  run.blendDrawCalls = 0;
  run.frame++;
  run.feedbackWritten = false;
  run.gpuFrameActive = false;
  run.hizPyramidFresh = false;
  run.gpuMetricsReady = false;
  if (run.gpuSelection?.failed()) fallbackToCpuCut(rt, 'selection readback failed');
  if (!capture.capturing && run.gpuSelection?.residentCut && vis.gpuDraw && vis.visEnabled) {
    if (!renderGpuCut(rt, cam, pixelError, cpuStart, lightsEnd)) renderWebgpuPages(rt, camera);
  } else renderCpuCut(rt, cam, pixelError, cpuStart, lightsEnd);
}
