import { colouredHostSurface, hostPageScene, releaseHostSurface } from '../../host/pageObjects.ts';
import { pageDiagnostics } from '../../host/pageDiagnostics.ts';
import { attachedPages, autonomousPlacements } from '../../placement/autonomousPlacements.ts';
import { collectClusterPages, indexPagesByUrl } from '../../page/selection/selection.ts';
import type { PageRec } from '../../page/selection/selection.ts';
import { createAutonomousRender, createAutonomousRenderState } from './render.ts';
import { autonomousCapabilities } from './capabilities.ts';
import { createWebglFrameGate } from '../../webgl/core/frameGate.ts';
import { decodePageOffThread } from '../../page/decode/host.ts';
import { createAutonomousGeometry } from './geometry.ts';
import { createAutonomousInstances } from './instances.ts';
import { prepareAutonomousManifest, autonomousBootstrap } from './manifest.ts';
import { createAutonomousResidency } from './residency.ts';
import { createAutonomousPool } from './poolApi.ts';
import { createHeldFloor } from './heldFloor.ts';
import { createContractLighting, graphBackground } from '../../lighting/contractLightingApi.ts';
import { createSceneDraw } from '../../webgl/cluster/sceneDraw.ts';
import type { BackendFactory } from '../types.ts';
import { createBlendCopy } from '../../cluster/blendCopyMesh.ts';
import type { HostMaterial } from '../../host/resources.ts';

/** WebGL2 path backed only by independently decoded prepared geometry pages. */
export const autonomousPagesBackend: BackendFactory = (context) => {
  const { metadata, descriptors } = prepareAutonomousManifest(context.metadata);
  const { roots, allPages, worlds, blendCopies } = collectClusterPages(
    context.source,
    metadata,
    new Map(),
    context.associations,
    { allowMissing: true, blendCopy: createBlendCopy },
  );
  const [baseRoots, basePages] = [roots.slice(), allPages.slice()];
  const bootstrap = autonomousBootstrap(roots),
    baseBootstrap = bootstrap.slice();
  const byUrl = indexPagesByUrl(allPages, (rec) => rec.url), // by page, not by stream bundle
    bootstrapUrls = new Set(bootstrap.map((page) => page.url));
  // The display graph's page ceiling: the host's, or the default raised to the root cover (#527).
  const hostCeiling = context.maxResidentPages ?? Infinity,
    pageDefault = context.residentPagesDefault ?? Math.max(1024, bootstrapUrls.size),
    cap = hostCeiling < Infinity ? hostCeiling : pageDefault,
    scene = hostPageScene(blendCopies);
  // The cut drawn, the cut wanted, and what the image asks the pool for (`imageCut.ts`).
  const lists = { shown: [] as PageRec[], desired: [] as PageRec[], requested: [] as PageRec[] };
  const baseMaterials = new Map(allPages.map((rec) => [rec, rec.declaration] as const)),
    colorMaterials = new Map<HostMaterial, HostMaterial>();
  const modifiedPages = new Set<string>();
  const state = createAutonomousRenderState(),
    gate = createWebglFrameGate(),
    hostDraw = createSceneDraw(context.webglContext, scene, blendCopies, context);
  // The engine's own lighting: the cache's radiometric light table where it declares one, the
  // source graph's lights otherwise (`../../lighting/contractLightingApi.ts`). A transmissive
  // surface is not paged: it is a copy the program draws whole (`hostPageScene`).
  const { lighting, api: lightingApi } = createContractLighting(scene, context, gate.sceneChanged);
  let ready = false;
  const geometryStore = createAutonomousGeometry({
    scene,
    allPages,
    bootstrap,
    ...lists,
    byUrl,
    descriptors,
    baseMaterials,
    colorMaterials,
    modifiedPages,
  });
  const { sync, acceptGeometryPage } = geometryStore;
  // The tables a placement enters: instances and instance-buffer rows append to the same.
  const tables = { roots, allPages, bootstrap, byUrl, baseMaterials };
  const heldFloor = createHeldFloor({ bootstrap, modifiedPages, byUrl });
  const ceiling =
    hostCeiling < Infinity ? () => hostCeiling : () => Math.max(pageDefault, heldFloor.meshes());
  const { disposeOwnedMaterials, instanceCount, ...instances } = createAutonomousInstances({
    ...tables,
    baseRoots,
    basePages,
    baseBootstrap,
    geometryStore,
    hostCeiling,
    coverMeshes: heldFloor.meshes,
    sceneChanged: gate.sceneChanged,
    coverChanged: heldFloor.placed,
  });
  const residency = createAutonomousResidency({
    bootstrapUrls,
    modifiedPages,
    ...lists,
    geometryStore,
  });
  const pool = createAutonomousPool({
    byUrl,
    context,
    descriptors,
    bootstrapUrls,
    modifiedPages,
    cap,
    gate,
    geometryStore,
    residency,
    heldFloor,
    instanceCount,
  });
  const frame = createAutonomousRender({
    state,
    context,
    gate,
    lighting,
    roots,
    blendCopies,
    worlds,
    ...lists,
    revision: () => heldFloor.placements,
    ceiling,
    geometry: geometryStore,
    residency,
    pool: pool.budget,
  });
  return {
    id: 'autonomous-pages-webgl',
    scene,
    hostTableBytes: frame.hostBytes,
    hostDiagnostics: pageDiagnostics,
    capabilities: autonomousCapabilities(!!context.metadata.simplification),
    get overBudget() {
      return state.overBudget;
    },
    get frameHeld() {
      return state.frameHeld;
    },
    async prepare() {
      if (!context.readGeometryPage) throw new Error('AUTONOMOUS_PAGE_READER_MISSING');
      if (heldFloor.meshes() > hostCeiling) throw new Error('AUTONOMOUS_ROOT_BUDGET');
      await Promise.all(
        [...bootstrapUrls].map(async (url) => {
          context.signal?.throwIfAborted();
          const bytes = await context.readGeometryPage!(url);
          context.signal?.throwIfAborted();
          acceptGeometryPage(url, await decodePageOffThread(bytes, context.signal));
        }),
      );
      heldFloor.changed();
      ready = true;
      for (const page of bootstrap) lists.shown.push(page); // a spread overflows the stack
      sync();
      residency.keptChanged();
    },
    render(camera) {
      hostDraw.render(camera);
      if (ready) frame(camera);
    },
    ...hostDraw.host,
    ...instances,
    ...autonomousPlacements({
      ...tables,
      blendCopies,
      scene,
      gate,
      rowsWritten: geometryStore.rowsWritten,
      coverChanged: heldFloor.placed,
    }),
    ...lightingApi,
    setClearColor: graphBackground(scene, gate.resourcesChanged),
    pendingUrls: residency.pendingUrls,
    pageUrls: residency.pageUrls,
    ...pool.api,
    syncResident() {
      gate.resourcesChanged();
      sync();
    },
    refreshMaterials(values = true) {
      // Values reach the twins, clones; a picture alone (#362), shared, only lets the image go.
      if (values) colorMaterials.forEach((twin, original) => colouredHostSurface(original, twin));
      (values ? gate.sceneChanged : gate.resourcesChanged)();
    },
    metrics() {
      return {
        clusters: state.visible,
        selectedTriangles: state.selectedTriangles,
        ...pool.metrics,
        cacheEvictions: residency.cacheEvictions,
        frustumRejected: state.frustumRejected,
        lodLevel: state.lodLevel,
        submittedTriangles: geometryStore.state.submittedTriangles,
        totalSubmittedTriangles: hostDraw.counters()?.triangles ?? null,
        drawCalls: attachedPages(lists.shown),
        coverageReady: ready,
        coverageBudgetLimited: state.overBudget || pool.budget.coverageBudgetLimited,
        frameHeld: state.frameHeld,
      };
    },
    dispose() {
      ready = false;
      hostDraw.dispose();
      geometryStore.dispose();
      disposeOwnedMaterials();
      for (const material of colorMaterials.values()) releaseHostSurface(material);
      scene.clear();
      gate.release();
    },
  };
};
