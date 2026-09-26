import { addCpuSteps } from '../../../stage/cpuSteps.ts';
import { CPU_STEP, CPU_STEP_STAGES } from './cpuStepTable.ts';
import { sunFarCounts } from '../prepare/sunFar.ts';
import {
  frameCostAuditEnabled,
  gpuFrameCostSnapshot,
  logFrameCostAudit,
} from '../../../frame/costAudit.ts';
import type { HostCpuStep } from '../../../host/cpuProfile.ts';
import { shadowPoolHeld } from '../../shadow/poolSize.ts';
import type { WebgpuPagesRuntime } from '../runtime.ts';

/** Deposits the image's CPU bounds into the public per-stage profile, when it is mounted. */
function recordStages(rt: WebgpuPagesRuntime) {
  const { timing, lights, bounce } = rt,
    stages = timing.stages;
  if (!stages) return;
  stages.frameCpu((add) => addCpuSteps(CPU_STEP_STAGES, timing.cpuProfile.row, add));
  const tiles = rt.vis.textures?.counters;
  if (tiles)
    stages.setCounts('textures', {
      tuilesDemandees: tiles.requested,
      tuilesAuNiveau: tiles.atLevel,
      niveauxManquants: Math.round(tiles.missingAverage * 100),
      tuilesServies: tiles.served,
      tuilesEnAttente: tiles.pending,
      tuilesReportees: tiles.deferred,
    });
  if (!tiles?.worked)
    stages.setReason('textures', {
      cpu: 'no image feedback: no tile to serve',
      gpu: 'transfers go through the GPU queue, with no timestamped pass',
    });
  // What the shadow pass actually did: counts, never durations. `pagesDemandees` is what the image
  // read, `pagesEnCache` what it read straight from the pool, `pagesInvalidees` what staled this
  // image, `pagesVisitees` what the invalidation examined to find them, `pagesRedessinees` what
  // it drew, `pagesEnAttente` what the budget left for later, and `retardMaxMs` the wait of the
  // oldest page in that queue.
  const { counts } = lights.plan;
  // What the region culls kept, sampled on the device one frame in fifteen: the frame it
  // describes is named, and until a sample has returned there is no count at all.
  const culled = lights.cull?.counts.counts();
  stages.setCounts('shadows', {
    lampesRedessinees: lights.shadowsUpdated,
    facesRedessinees: lights.shadowFaces,
    appelsDeDessin: lights.shadowDrawCalls,
    soleilsRedessines: counts.sunLights,
    pagesDemandees: lights.plan.requests.counts.requested,
    pagesEnCache: counts.cachedPages,
    pagesDuPool: counts.poolPages,
    octetsDuPool: shadowPoolHeld(lights),
    couchesDuPool: lights.plan.pool.layers,
    pagesInvalidees: counts.invalidatedPages,
    pagesVisitees: counts.visitedPages,
    pagesRedessinees: lights.shadowPages,
    pagesEnAttente: counts.pendingPages,
    retardMaxMs: counts.waitedMs,
    retardMaxImages: counts.waitedFrames,
    ...(culled
      ? {
          occludeursGardes: culled.kept,
          regionsRelevees: culled.regions,
          imageRelevee: culled.frame,
        }
      : {}),
  });
  stages.setCounts('lightLists', { lampesActives: lights.lightsActive });
  // The sun's far shadow: counts sampled one image in fifteen, never a duration. Its ray is traced
  // in deferred resolve, so its milliseconds are those of the Lighting (resolve) stage — stating a
  // duration here would count it a second time.
  stages.setCounts('sunFarShadows', sunFarCounts(rt));
  stages.setReason('sunFarShadows', {
    cpu: 'no CPU work: the far ray is traced by deferred resolve',
    gpu: rt.sunFar.reason ?? 'measured in the Lighting (resolve) stage, which traces the far ray',
  });
  // What bounce actually did: probes and rays, never a duration. A still, converged scene encodes
  // no pass, so the stage stays "unmeasured" and not zero.
  stages.setCounts('bounce', {
    sondesMisesAJour: bounce.probesUpdated,
    rayonsParImage: bounce.raysLaunched,
    sondesDesCascades: bounce.probes?.cascades.probes ?? 0,
    maillesMisesAJour: bounce.encoded ? (bounce.probes?.surface.lastTexels ?? 0) : 0,
    maillesDuCache: bounce.probes?.surface.texels ?? 0,
    // Fraction of the ceiling the millisecond budget holds, in thousandths: a count is an integer,
    // and it is the duration that decides this count, never the reverse.
    fractionDuBudget: Math.round((bounce.probes?.budget.load ?? 0) * 1000),
  });
  if (!bounce.probes)
    stages.setReason('bounce', {
      cpu: bounce.reason ?? 'bounce absent',
      gpu: bounce.reason ?? 'bounce absent',
    });
  // Diagnostic only: transparent overdraw count, when the variant mounts it. The per-pixel maximum
  // is not measurable by occlusion query: it is not published.
  const overdraw = rt.blendState.overdraw;
  if (overdraw)
    stages.setCounts('transparents', overdraw.pull(rt.gpu.targetSize[0] * rt.gpu.targetSize[1]));
  // Occupancy of the cut: how many clusters the DAG holds, how many the frustum and nodes reject,
  // how many the cut keeps. That ratio says what a kernel that visits every cluster costs versus
  // only the live ones.
  stages.setCounts('selection', {
    grappesRejetees: rt.run.frustumRejected,
    pagesVoulues: rt.run.visible,
    grappesDuDag: rt.run.gpuSelection?.pageCount ?? 0,
  });
  stages.setCounts('animations', timing.worldCounts);
  stages.setCounts('partition', timing.partitionCounts);
  timing.encodeCounts.appelsDeDessin = rt.run.gpuDrawCalls;
  timing.encodeCounts.appelsDeMelange = rt.run.blendDrawCalls;
  timing.encodeCounts.lancementsDeCalcul = rt.run.gpuComputeDispatches;
  stages.setCounts('encode', timing.encodeCounts);
}

/**
 * Publishes where the image's CPU time went, on the cadence of the progress diagnostic. It is called
 * by both render paths: a measured loop renders without ever flushing, and the profile is exactly what
 * such a loop needs.
 */
export function publishCpuProfile(rt: WebgpuPagesRuntime) {
  const { timing, run, diag } = rt;
  if (
    (diag.traceEnabled && !frameCostAuditEnabled()) ||
    !timing.cpuSample ||
    run.frame === timing.lastCpuLogFrame
  )
    return;
  const now = performance.now();
  if (now - timing.lastCpuLogMs < 2000) return;
  timing.lastCpuLogMs = now;
  timing.lastCpuLogFrame = run.frame;
  const details = {
    ...timing.cpuSample,
    steps: timing.cpuProfile.summary(),
    audit: gpuFrameCostSnapshot(rt),
  };
  diag.engineDiagnostic('cpu-timing', 'CPU timings measured in the engine', details);
  logFrameCostAudit('webgpu-page-raster', { kind: 'cpu-profile', ...details });
}

/** Deposits the duration of a host-sampled step: arrivals, wait, retain, submit. */
export function hostCpuStep(rt: WebgpuPagesRuntime, step: HostCpuStep, ms: number) {
  rt.timing.cpuProfile.row[CPU_STEP[step]] = ms;
}

/**
 * Closes the image on the host side: bounds the host samples after the render belong to the image
 * that just drew, so the row is filed only here. An image that has not filled a row — CPU cut, image
 * waiting for coverage — deposits nothing rather than a row of zeros.
 */
export function endCpuFrame(rt: WebgpuPagesRuntime) {
  const { timing, run } = rt;
  if (!timing.rowFilled) return;
  timing.rowFilled = false;
  const total = timing.cpuProfile.row[CPU_STEP.totalMs];
  timing.cpuProfile.record(run.frame, total);
  timing.cpuWindow.record(run.frame, total);
  recordStages(rt);
  publishCpuProfile(rt);
}
