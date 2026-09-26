import { DIAGNOSTICS } from '../../../../sdk-core/src/index.ts';
import type { ExplorerProbe } from '../session/capabilityProbe.ts';
import type { ExplorerRuntimeSurface } from '../render/hostRuntime.ts';
import { createExplorerCameraApi } from './cameraApi.ts';
import { createExplorerDiagnosticApi } from './diagnosticApi.ts';
import { createExplorerSceneApi } from './sceneApi.ts';
import { createExplorerSelectionApi } from './selectionApi.ts';
import { createExplorerViewportApi } from './viewportApi.ts';
import { createExplorerTelemetryApi } from './telemetryApi.ts';
import { createExplorerLightApi } from './lightApi.ts';
import { createExplorerMaterialApi } from './materialApi.ts';

type Inputs = ExplorerRuntimeSurface & {
  capabilities: ExplorerProbe['capabilities'];
  preparationMs: number;
};

export function createExplorerApi(inputs: Inputs) {
  const {
    options,
    capabilities,
    preparationMs,
    camera,
    center,
    bounds,
    metadata,
    backends,
    canvas,
    render,
    capture,
    captureView,
    gpuDevice,
    dispose,
    setPose,
    awaitPages,
    flush,
    check,
    scope,
    directGpu,
    viewport,
    context,
    homeOffset,
    lookAtTarget,
    radius,
    hostedControls,
    beautyMaterials,
    overlays,
    profiler,
    state,
    setActive,
    setDiagnostic,
    setCapturingSurface,
    setMeasuring,
    setComparison,
  } = inputs;
  return {
    capabilities,
    get fallbackReason() {
      return state.fallbackReason;
    },
    preparationMs,
    camera,
    center,
    bounds,
    metadata,
    backends,
    canvas,
    render,
    capture,
    /** The composed image at a size of its own, drawn offscreen, bottom row first. */
    captureView,
    /** The WebGPU device the session draws on, when it has one: a world reopening keeps it. */
    gpuDevice,
    dispose,
    setPose,
    awaitPages,
    flush,
    ...createExplorerSceneApi({
      check,
      active: () => state.active,
      backends,
      render,
      flush,
      capture,
      scope,
      canvas,
    }),
    ...createExplorerViewportApi({
      check,
      active: () => state.active,
      setCapturingSurface,
      targets: () => [state.measurementTarget, state.pairTargetA, state.pairTargetB],
      camera,
      canvas,
      webglSurface: inputs.webglSurface,
      viewport,
      options,
    }),
    ...createExplorerSelectionApi({
      check,
      backends,
      diagnostic: () => state.diagnostic,
      selectBackend: setActive,
      setComparison,
      directGpu,
      context,
    }),
    get comparison() {
      const { comparisonLayout, comparisonPair, wipe, toggle } = state;
      return { layout: comparisonLayout, pair: comparisonPair, wipe, toggle };
    },
    ...createExplorerCameraApi({
      check,
      options,
      camera,
      center,
      homeOffset,
      lookAtTarget,
      radius,
      canvas,
      backends,
      disposed: () => state.disposed,
      setMeasuring,
      setActive,
      hostedControls,
    }),
    get backend() {
      return state.active.id;
    },
    get diagnostic() {
      return state.diagnostic;
    },
    diagnostics: DIAGNOSTICS,
    ...createExplorerDiagnosticApi({
      check,
      active: () => state.active,
      backends,
      beautyMaterials,
      overlays,
      setMode: setDiagnostic,
    }),
    ...createExplorerLightApi({
      check,
      store: context.sceneLights,
      imported: context.importedLightIds ?? [],
      backends,
      active: () => state.active,
      onDiagnostic: context.onDiagnostic,
    }),
    ...createExplorerMaterialApi({
      check,
      source: context.source,
      backends,
      active: () => state.active,
    }),
    ...createExplorerTelemetryApi(profiler, () => state.active),
  };
}
