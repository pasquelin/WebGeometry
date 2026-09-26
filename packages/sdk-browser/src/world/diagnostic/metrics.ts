import { mathBatchMetrics } from '../../math/batchState.ts';
import { pageIntegrationStats } from '../../page/integration/host.ts';
import { pageDecodeStats } from '../../page/decode/host.ts';
import { EngineProfiler } from '../../diagnostic/telemetry.ts';
import type { FrameMetrics, ClusterManifest } from '../../../../sdk-core/src/index.ts';
import type { MeasuredWorldOptions, RenderBackend } from '../../backend/types.ts';
import { BACKEND_METRIC_KEYS } from '../../diagnostic/metricKeys.ts';
import type { createPageStreamer } from '../../streaming/pageStreamer.ts';

type State = () => {
  loaded: number;
  pageBytesRead: number;
  streamingError: string | null;
  /** Bytes of the effect chain's targets on the host context (`../render/compose.ts`). */
  effectBytes: number;
};

/** Copies an engine measurement into the host sample: `null` when that engine does not hold it. */
function publishMetric<K extends (typeof BACKEND_METRIC_KEYS)[number]>(
  into: FrameMetrics,
  from: FrameMetrics,
  key: K,
) {
  into[key] = (from[key] ?? null) as FrameMetrics[K];
}

export function createExplorerMetrics(
  metadata: ClusterManifest,
  options: MeasuredWorldOptions,
  streamer: ReturnType<typeof createPageStreamer>,
  loaded: number,
  pageBytesRead: number,
  state: State,
) {
  const metricsScratch: FrameMetrics = {
    rafIntervalMs: null,
    cpuFrameMs: 0,
    cpuSelectMs: null,
    cpuSelectNodesTested: null,
    cpuSubmitMs: null,
    drawCalls: null,
    triangles: null,
    clusters: null,
    selectedTriangles: null,
    residentPages: null,
    geometryAllocationBytes: null,
    vramBytes: null,
    pageLoads: loaded,
    pageBytesRead,
    pagesDetached: null,
    cacheEvictions: null,
    hizCountedFrame: null,
    hizTestedClusters: null,
    hizRejectedClusters: null,
    hizOversizedClusters: null,
    hizTestedTriangles: null,
    hizRejectedTriangles: null,
    hizOversizedTriangles: null,
    gpuPassMs: null,
    gpuFrameMs: null,
    gpuHostGapMs: null,
    uncoveredTriangles: null,
    drawnTriangles: null,
    lightsActive: null,
    lightsSampled: null,
    shadowsUpdated: null,
    shadowFacesDrawn: null,
    shadowDrawCalls: null,
    shadowLightCuts: null,
    shadowPagesRequested: null,
    shadowPagesCached: null,
    shadowPoolPages: null,
    shadowPoolBytes: null,
    shadowPoolLayers: null,
    shadowPagesRefetched: null,
    shadowCastersKept: null,
    shadowCastersHidden: null,
    shadowPagesDrawn: null,
    shadowPagesTotal: null,
    shadowPagesPending: null,
    shadowWaitMs: null,
    gpuLightListsMs: null,
    gpuShadowsMs: null,
    gpuShadowCullMs: null,
    gpuShadowRasterMs: null,
    gpuLightingMs: null,
    texturePoolBytes: null,
    texturePoolFormat: null,
    textureResidentBytes: null,
    textureBytesLastFrame: null,
    pagesDecodedOffThread: null,
    pagesDecodedWasm: null,
    pageDecodeMs: null,
    mathBatch: null,
  };
  const profiler = new EngineProfiler();
  profiler.setMetadata(metadata);
  if (options.logInterval && options.logInterval > 0) profiler.startAutoLog(options.logInterval);
  const fillMetrics = (backend: RenderBackend) => {
    const { loaded, pageBytesRead, streamingError, effectBytes } = state();
    const backendMetrics = backend.metrics() as FrameMetrics;
    const stream = streamer.stats();
    // Every measurement the engine publishes as-is, in contract order: `null` means "not
    // held by this engine", never "zero". The held-frame flag is part of that — without this
    // copy, `explorer.render()` published `null` while the engine had in fact held the frame.
    for (const key of BACKEND_METRIC_KEYS) publishMetric(metricsScratch, backendMetrics, key);
    // The chain the host composes holds targets of its own: they count with the frame's.
    if (effectBytes)
      metricsScratch.gpuFrameTargetBytes = (metricsScratch.gpuFrameTargetBytes ?? 0) + effectBytes;
    metricsScratch.streamingError = streamingError;
    metricsScratch.clusters = backendMetrics.clusters;
    metricsScratch.selectedTriangles = backendMetrics.selectedTriangles;
    metricsScratch.residentPages = backendMetrics.residentPages;
    metricsScratch.geometryAllocationBytes = backendMetrics.geometryAllocationBytes;
    metricsScratch.cacheEvictions = backendMetrics.cacheEvictions ?? stream.evictions;
    // A composed total exists only if each of its parts is counted: an engine that does not
    // count its transparent pass leaves the total at `null`, otherwise the opaque pass alone
    // would pass for the exact count of the frame.
    metricsScratch.totalSubmittedTriangles =
      backendMetrics.totalSubmittedTriangles ??
      (backendMetrics.submittedTriangles == null ||
      backendMetrics.transparentSubmittedTriangles == null
        ? null
        : backendMetrics.submittedTriangles + backendMetrics.transparentSubmittedTriangles);
    metricsScratch.pageLoads = stream.loaded || loaded;
    metricsScratch.pageBytesRead = stream.bytesRead || pageBytesRead;
    metricsScratch.pagesRequested = stream.requested;
    metricsScratch.pagesLoading = stream.loading;
    metricsScratch.cacheHits = stream.hits;
    metricsScratch.cacheMisses = stream.misses;
    metricsScratch.drawCalls = backendMetrics.drawCalls ?? null;
    const decode = pageDecodeStats();
    metricsScratch.pagesDecodedOffThread = decode.offThread;
    metricsScratch.pagesDecodedWasm = decode.wasm;
    metricsScratch.pageDecodeMs = decode.decodeMs;
    metricsScratch.mathBatch = mathBatchMetrics();
    const integration = pageIntegrationStats();
    metricsScratch.pagesPlannedOffThread = integration.offThread;
    metricsScratch.pagePlanMs = integration.planMs;
  };
  return { metricsScratch, profiler, fillMetrics };
}
