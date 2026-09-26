import type { FrameMetrics } from '../../../sdk-core/src/index.ts';

/**
 * The measurements an engine publishes as-is and the host copies one by one, `null` when that
 * engine does not hold them. The list IS the contract: the type `metrics()` returns derives from
 * it, so a measurement added here is copied without a second list having to be written by hand.
 */
export const BACKEND_METRIC_KEYS = [
  'coverageReady',
  'coverageBudgetLimited',
  'uncoveredTriangles',
  'drawnTriangles',
  'pagesDetached',
  'frustumRejected',
  'hizTestedClusters',
  'hizRejectedClusters',
  'hizOversizedClusters',
  'hizTestedTriangles',
  'hizRejectedTriangles',
  'hizOversizedTriangles',
  'hizCountedFrame',
  'lodLevel',
  'frameHeld',
  'autonomousClusterDrawsTotal',
  'autonomousCopyDraws',
  'transmissionBackdropBytes',
  'submittedTriangles',
  'transparentMeshes',
  'transparentFrustumRejected',
  'transparentDrawCalls',
  'transparentSubmittedTriangles',
  'cpuSelectMs',
  'gpuSelectionFallback',
  'cpuSelectNodesTested',
  'cpuSubmitMs',
  'gpuPassMs',
  'gpuFrameMs',
  'gpuHostGapMs',
  'vramBytes',
  'gpuAllocatedBytes',
  'gpuAllocatedByLabel',
  'gpuAllocationsUnknownFormat',
  'gpuFrameTargetBytes',
  'geometryPoolBytes',
  'geometryPoolSlots',
  'geometryPoolAllocatedBytes',
  'geometryPoolClamp',
  'geometryPoolSaturated',
  'texturePoolClamp',
  'texturePoolBytes',
  'texturePoolFormat',
  'texturePoolLayers',
  'textureTilesResident',
  'textureResidentBytes',
  'textureTilesRequested',
  'textureTilesAtLevel',
  'textureMissingLevels',
  'textureTilesPending',
  'textureTilesDeferred',
  'textureTilesServed',
  'textureTilesEvicted',
  'textureTilesRefused',
  'textureBytesLastFrame',
  'textureUploadMs',
  'textureUploadPeakMs',
  'textureLevelReads',
  'textureLevelsDecoded',
  'textureLevelCacheBytes',
  'textureScratchBuilds',
  'textureLiveBytes',
  'lightsActive',
  'lightsSampled',
  'shadowsUpdated',
  'shadowFacesDrawn',
  'shadowDrawCalls',
  'shadowLightCuts',
  'shadowPagesRequested',
  'shadowPagesCached',
  'shadowPoolPages',
  'shadowPoolBytes',
  'shadowPoolLayers',
  'shadowPagesRefetched',
  'shadowCastersKept',
  'shadowCastersHidden',
  'shadowPagesDrawn',
  'shadowPagesTotal',
  'shadowPagesPending',
  'shadowWaitMs',
  'gpuLightListsMs',
  'gpuShadowsMs',
  'gpuShadowCullMs',
  'gpuShadowRasterMs',
  'gpuLightingMs',
] as const;

/** Measurements the host composes itself, from the engine and its own counters. */
type ComposedMetric =
  | 'clusters'
  | 'selectedTriangles'
  | 'residentPages'
  | 'geometryAllocationBytes'
  | 'cacheEvictions'
  | 'totalSubmittedTriangles';

/** What an engine publishes of its frame: the measurements copied as-is, and those the
 *  host composes. */
export type BackendMetrics = Partial<
  Pick<FrameMetrics, (typeof BACKEND_METRIC_KEYS)[number] | ComposedMetric>
>;
/** Draw counters a WebGL2 engine adds to its metrics. */
export type BackendDrawCounters = {
  drawCalls?: number;
  batchRebuilds?: number;
  batchIndexBytesUpdated?: number;
  pageRangeWrites?: number;
  subDraws?: number;
};
