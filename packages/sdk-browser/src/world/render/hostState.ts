import type { CameraPose, DiagnosticMode } from '../../../../sdk-core/src/index.ts';
import type { MeasuredWorldOptions, RenderBackend } from '../../backend/types.ts';
import { createComparisonCompositor, type ComparisonLayout } from '../../measurement/comparison.ts';
import { createFrameComposer } from './compose.ts';
import { pixelRatioOf } from '../../backend/common.ts';
import type { createExplorerDiagnosticApi } from '../api/diagnosticApi.ts';
import type { prepareExplorer } from '../session/prepare.ts';
import { boundToContext } from '../../webgl/core/contextBound.ts';
import { createWebglRenderTarget, type WebglRenderTarget } from '../../webgl/core/renderTarget.ts';
import type { WebglSurface } from '../../webgl/core/surface.ts';

/** The host materials the diagnostic modes swap and create, held by the session. */
type DiagnosticInputs = Parameters<typeof createExplorerDiagnosticApi>[0];

type Prepared = Awaited<ReturnType<typeof prepareExplorer>>;
/** A composition target that outlives a context loss: `current()` is the live one. */
export type BoundTarget = ReturnType<typeof boundToContext<WebglRenderTarget>>;

/** The mutable state of one explorer host; every service reads and writes this same object. */
export type ExplorerHostState = {
  fallbackReason: string | null;
  active: RenderBackend;
  disposed: boolean;
  diagnostic: DiagnosticMode;
  capturingSurface: boolean;
  measuring: boolean;
  hostFrame: number;
  comparisonLayout: ComparisonLayout;
  comparisonPair: [string, string];
  wipe: number;
  toggle: 0 | 1;
  pairTargetA?: BoundTarget;
  pairTargetB?: BoundTarget;
  measurementTarget?: BoundTarget;
  loaded: number;
  pageBytesRead: number;
};

export function createExplorerHostState(
  prepared: Prepared,
  options: MeasuredWorldOptions,
  backends: RenderBackend[],
  canvas: HTMLCanvasElement,
  webglSurface: WebglSurface | undefined,
  signal?: AbortSignal,
) {
  const { camera, center } = prepared;
  const baseline =
    backends.find((backend) => backend.id === 'three-webgl-reference') ?? backends[0];
  // The engine's own paths render: the WebGPU page raster, else the autonomous WebGL2 path.
  // A Three witness only becomes active in a session that holds nothing else, which is to say
  // a session whose host named one itself (`chooseBackends`).
  const optimized =
    backends.find((backend) => backend.id === 'webgpu-page-raster') ??
    backends.find((backend) => backend.id === 'autonomous-pages-webgl') ??
    backends.find((backend) => backend.id === 'exact-cluster-pages') ??
    baseline;
  const state: ExplorerHostState = {
    fallbackReason: null,
    active: optimized,
    disposed: false,
    diagnostic: 'beauty',
    capturingSurface: false,
    measuring: false,
    hostFrame: 0,
    comparisonLayout: options.comparisonLayout ?? 'single',
    comparisonPair: options.comparisonPair ?? [
      baseline.id,
      backends.find((backend) => backend.id === 'exact-cluster-pages')?.id ??
        backends[backends.length - 1].id,
    ],
    wipe: 0.5,
    toggle: 0,
    loaded: prepared.pageSources.loaded,
    pageBytesRead: prepared.pageSources.pageBytesRead,
  };
  if (prepared.directGpu && state.comparisonLayout !== 'single')
    throw new Error('SINGLE_BACKEND_COMPARISON');
  const beautyMaterials: DiagnosticInputs['beautyMaterials'] = new Map();
  const overlays: DiagnosticInputs['overlays'] = [];
  const hostedControls: { dispose(): void }[] = [];
  const lookAtTarget = center.clone();
  // The composition lives on the engine's context: the composer, which puts an engine's image
  // on the surface or a target for the frame and the explicit capture alike, and the comparison
  // compositor. The direct GPU path composes nothing.
  const gl = webglSurface?.context;
  const composition = gl
    ? {
        compose: createFrameComposer(gl, camera, {
          effects: options.effects && {
            chain: options.effects,
            shown: () => state.diagnostic === 'beauty',
            refused: options.effectsRefused,
          },
          guides: options.guides,
          pixelRatio: () => pixelRatioOf(options),
          particles: options.particles,
          particlesRefused: options.particlesRefused,
        }),
        compositor: createComparisonCompositor(gl),
      }
    : {
        compose: Object.assign(
          () => {
            throw new Error('The direct GPU path has no host composer');
          },
          { dispose() {}, effectBytes: () => 0 },
        ),
        compositor: undefined,
      };
  /** One side of a comparison or the measurement surface, at the drawing-buffer size. */
  const ensureTarget = (current?: BoundTarget) => {
    if (!gl) throw new Error('The direct GPU path has no host render target');
    return (
      current ??
      boundToContext(
        gl,
        () => createWebglRenderTarget(gl, canvas.width, canvas.height),
        (target) => target.dispose(),
      )
    );
  };
  const check = () => {
    if (state.disposed) throw new Error('MeasuredWorld disposed');
    if (state.capturingSurface) throw new Error('SURFACE_CAPTURE_BUSY');
    signal?.throwIfAborted();
  };
  const setPose = (pose: CameraPose) => {
    camera.position.fromArray(pose.position);
    camera.fov = pose.fov;
    camera.near = pose.near;
    camera.far = pose.far;
    camera.lookAt(lookAtTarget.fromArray(pose.target));
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  };
  return {
    state,
    baseline,
    webglSurface,
    beautyMaterials,
    overlays,
    hostedControls,
    lookAtTarget,
    ...composition,
    disposeComposition() {
      composition.compose.dispose();
      composition.compositor?.dispose();
    },
    ensureTarget,
    check,
    setPose,
  };
}
