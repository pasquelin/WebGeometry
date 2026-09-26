import type { HostTexture } from '../../host/resources.ts';
import { DEFAULT_CLEAR_COLOR, isCancelled, pixelRatioOf } from '../../backend/common.ts';
import { createSceneLightStore, dagWarningsDiagnostic } from '../../../../sdk-core/src/index.ts';
import { createSceneProxyReader } from '../../scene/proxyLoad.ts';
import { createTextureLevelReader } from '../../texture/levelReader.ts';
import { resolveDiagnosticGpuVariant } from '../../diagnostic/gpuVariant.ts';
import { declareImportedLights, loadImportedLights } from '../../lighting/importedLights.ts';
import type { BackendContext, BackendFactory, RenderBackend } from '../../backend/types.ts';
import type { createExplorerPageSources } from './pageSources.ts';
import type { ExplorerSession } from './session.ts';
import type { Object3D } from '../../../../sdk-core/src/world/object/object3d.ts';

type Inputs = {
  source: Object3D;
  sceneLightingSource?: Object3D;
  associations: BackendContext['associations'];
  textureIndices: Map<HostTexture, number>;
  pageSources: Awaited<ReturnType<typeof createExplorerPageSources>>;
  gpuDevice?: GPUDevice;
  webglContext?: WebGL2RenderingContext;
  directGpu: boolean;
  /** The engine paths this session renders through, already chosen (`chooseBackends`). */
  factories: BackendFactory[];
  backends: RenderBackend[];
  /** Manifest url base: that is what locates the resident-proxy cache object. */
  base: string;
  frameBudget?: BackendContext['frameBudget'];
};

export async function prepareExplorerBackends(session: ExplorerSession, inputs: Inputs) {
  const { canvas, options, scope, metadata, signal, diagnosticChannel, emit, diagnose } = session;
  const {
    source,
    sceneLightingSource,
    associations,
    textureIndices,
    pageSources,
    gpuDevice,
    webglContext,
    directGpu,
    factories,
    backends,
    base,
  } = inputs;
  const { indices, streamer, attachCap, cacheCap, preload } = pageSources;
  const viewport: [number, number] = [canvas.width, canvas.height];
  // One light store per session: every engine reads it, the host is the only one that writes it.
  const sceneLights = createSceneLightStore();
  // Lights the source file carried, declared before the first engine: the `auto` view knows
  // from its first frame that it has a source, and no engine prepares on an empty store that
  // would then have to be pushed. A cache without this product declares none, as before.
  let importedLightIds: string[] = [];
  if (options.importedLights !== false) {
    const imported = await loadImportedLights(base, signal);
    importedLightIds = declareImportedLights(sceneLights, imported.lights);
    if (importedLightIds.length || Object.keys(imported.rejected).length)
      diagnose('imported-lights', 'Lights declared by the source file', {
        kind: 'preparation',
        declared: importedLightIds.length,
        rejected: imported.rejected,
        scope,
      });
  }
  // What the compiler named without being able to fix it — a DAG that is not mounted — is
  // said at open, before the engine is chosen: it is a fact of the cache, not of an engine.
  const dagWarnings = dagWarningsDiagnostic(metadata.primitives);
  if (dagWarnings)
    diagnose(dagWarnings.phase, dagWarnings.message, {
      kind: 'preparation',
      ...dagWarnings.context,
    });
  const context: BackendContext = {
    source,
    metadata,
    indices,
    readPage: (url) => streamer.read(url),
    readGeometryPage: (url) => streamer.readBytes(url),
    associations: associations,
    textureIndices,
    signal,
    // The page ceiling is the host's, or nothing: the WebGPU engine holds its pool in bytes;
    // host-memory engines keep by default what the streamer computed for them.
    maxResidentPages: options.maxResidentPages,
    residentPagesDefault: attachCap,
    maxCachedPages: cacheCap,
    pixelError: options.pixelError ?? 0,
    lodAdaptive: options.lodAdaptive,
    clearColor: options.clearColor ?? DEFAULT_CLEAR_COLOR,
    onDiagnostic: diagnosticChannel.enabled ? diagnosticChannel.emit : undefined,
    preparationStep: (step) => diagnose('backend-preparation-step', step, { kind: 'preparation' }),
    diagnosticDetail: diagnosticChannel.detail,
    viewport,
    pixelRatio: () => pixelRatioOf(options),
    gpuDevice,
    webglContext,
    gpuCanvas: directGpu ? canvas : undefined,
    maxTextureTransferBytesPerFrame: options.maxTextureTransferBytesPerFrame,
    maxTextureUploadMsPerFrame: options.maxTextureUploadMsPerFrame,
    temporalAntialiasing: options.temporalAntialiasing ?? true,
    effects: options.effects,
    geometryPoolBytes: options.geometryPoolBytes,
    geometryPoolCeilingBytes: options.geometryPoolCeilingBytes,
    texturePoolBytes: options.texturePoolBytes,
    textureCompression: options.textureCompression,
    stageProfile: options.stageProfile === true,
    // The diagnostic variant is checked here, once: outside `trace`, it is refused.
    diagnosticGpuVariant: resolveDiagnosticGpuVariant(
      options.diagnosticGpuVariant,
      diagnosticChannel.detail,
    ),
    shadowPageInvalidation: options.shadowPageInvalidation,
    sceneLighting: sceneLightingSource,
    guides: options.guides,
    particles: options.particles,
    particlesRefused: options.particlesRefused,
    // Bounced light stays off unless asked: its step holds 1.1 to 1.3 ms on Emerald, above 1 ms.
    bounce: options.bounce,
    bounceBudgetMs: options.bounceBudgetMs,
    readSceneProxy: createSceneProxyReader(metadata.proxy, base, options.pageCache, signal),
    // The reader exists as soon as the cache declares texture chains, whatever the host asked of
    // the loader: the engine reads the levels the compiler baked and regenerates none it could
    // have read instead. What `textureSource` still decides is whether the LOADER opens the
    // source images for an engine that draws the host scene, not where the engine's texels
    // come from. Its levels are held beside the pages the streamer reads (`textureLevels`).
    readTextureLevel: createTextureLevelReader(metadata, base, streamer.textureLevels, signal),
    sceneLights,
    importedLightIds,
    frameBudget: inputs.frameBudget,
  };
  for (const factory of factories) {
    const backend = factory(context);
    if (backends.some((b) => b.id === backend.id)) throw new Error('Duplicate backend id');
    const preparation = { kind: 'preparation' as const, backend: backend.id, scope };
    diagnose('backend-preparation-start', 'Backend preparation started', { ...preparation });
    try {
      await backend.prepare();
      backends.push(backend);
      diagnose('backend-preparation-complete', 'Backend preparation completed', { ...preparation });
    } catch (error) {
      // A release that fails is diagnosed; what went wrong before it still goes on.
      const release = async () => {
        try {
          await backend.dispose();
        } catch (disposeError) {
          diagnose('backend-dispose-error', 'Backend release failed', {
            kind: 'error',
            backend: backend.id,
            error: String(disposeError),
            scope,
          });
        }
      };
      // Cancelled — the session closed, or the backend did: nothing failed, nothing falls back, and
      // nothing of it outlives the session. An abort neither asked for is a failure like any other.
      if (isCancelled(backend.signal ?? signal)) {
        await release();
        throw error;
      }
      diagnose('backend-preparation-error', 'Backend preparation failed', {
        kind: 'error',
        backend: backend.id,
        error: String(error),
        scope,
      });
      // The fallback does not wait for the failed backend's release.
      void release();
      if (backend.id === 'webgpu-page-raster' && !directGpu) {
        emit({
          eventVersion: 1,
          type: 'fallback',
          audience: 'diagnostic',
          recovered: true,
          code: 'WEBGPU_UNAVAILABLE',
          detail: String(error),
        });
        diagnose('fallback', 'WebGPU backend unavailable; continue with other backends', {
          kind: 'fallback',
          backend: backend.id,
          error: String(error),
          scope,
        });
        continue;
      }
      throw error;
    }
  }
  if (preload !== 'all') indices.clear();
  if (!backends.length) throw new Error('No backend');
  // The engines' host tables, which follow the view, come out of the decoded pages' CPU share.
  streamer.reserve(() => backends.reduce((bytes, b) => bytes + (b.hostTableBytes?.() ?? 0), 0));
  return { viewport, context };
}
