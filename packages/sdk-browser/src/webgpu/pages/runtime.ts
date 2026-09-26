import { BOUNCE_SETTINGS } from '../../../../sdk-core/src/index.ts';
import { shadowPoolSide } from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { MOTION_CAPABILITY, TAA_CAPABILITY } from '../../taa/capability.ts';
import { BOUNCE_CAPABILITY } from './prepare/bounce.ts';
import type { BackendCapabilities, BackendContext, RenderBackend } from '../../backend/types.ts';
import { createWebgpuPagesServices, type WebgpuPagesServices } from './services.ts';
import { createWebgpuDiagnostics } from './io/diagnostics.ts';
import { createWebgpuBlendState } from '../blend/state.ts';
import { createWebgpuPagesSetup, type WebgpuDiagnostics } from './prepare/setup.ts';
import { createWebgpuPagesLayout, type WebgpuPagesLayout } from './prepare/layout.ts';
import { createWebgpuGpuState, type WebgpuGpuState } from './state/gpu.ts';
import { createWebgpuVisState, type WebgpuVisState } from './state/vis.ts';
import { createWebgpuLightState, type WebgpuLightState } from './state/lights.ts';
import { createWebgpuBounceState, type WebgpuBounceState } from './state/bounce.ts';
import { createWebgpuSunFarState, type WebgpuSunFarState } from './state/sunFar.ts';
import { createWebgpuRunState, type WebgpuRunState } from './state/run.ts';
import { createWebgpuCaptureState, type WebgpuCaptureState } from './state/capture.ts';
import {
  createWebgpuStageProfiler,
  createWebgpuTimingState,
  type WebgpuTimingState,
} from './state/timing.ts';
import type { HostCpuProfile } from '../../host/cpuProfile.ts';
import type { WebgpuPagesSetup } from './prepare/setup.ts';

export type WebgpuPagesBackend = RenderBackend &
  HostCpuProfile & {
    flush(): Promise<void>;
    rasterRgba(): Uint8Array;
    selectedPageIds(): string[];
    visibilityIds(): Uint32Array;
  };

/** The runtime before its services exist: what the service factory and the draw helpers are handed. */
export type WebgpuPagesCore = Omit<WebgpuPagesRuntime, 'services'>;

export const UNTEXTURED_MATERIALS = 'Untextured source color; double-sided when the material is';
export const VIS_FEATURES = [
  'visibility buffer',
  'textured PBR maps',
  'occlusion culling',
  'temporal occlusion culling',
];

/** The shared state of one WebGPU page-raster backend, handed to every module that implements a
 *  part of it. `setup` and `layout` never change after construction; the other groups do. */
export interface WebgpuPagesRuntime {
  context: BackendContext;
  /** Aborted by `dispose`; `signal` is aborted by it or by the session's. */
  closer: AbortController;
  signal: AbortSignal;
  diag: WebgpuDiagnostics;
  setup: WebgpuPagesSetup;
  layout: WebgpuPagesLayout;
  gpu: WebgpuGpuState;
  vis: WebgpuVisState;
  /** Contract lights, their per-tile lists and their shadow atlas. */
  lights: WebgpuLightState;
  /** Resident proxy and probe grid of bouncing light. */
  bounce: WebgpuBounceState;
  /** The sun's shadow beyond the last clipmap level, traced against the resident proxy. */
  sunFar: WebgpuSunFarState;
  run: WebgpuRunState;
  capture: WebgpuCaptureState;
  timing: WebgpuTimingState;
  capabilities: BackendCapabilities;
  blendState: ReturnType<typeof createWebgpuBlendState>;
  /** Residency machinery, built once the state exists; it reads the runtime lazily. */
  services: WebgpuPagesServices;
}

export function createWebgpuPagesRuntime(context: BackendContext): WebgpuPagesRuntime {
  const traceEnabled = !!context.onDiagnostic && context.diagnosticDetail !== 'summary';
  const diag = { ...createWebgpuDiagnostics(context.onDiagnostic, traceEnabled), traceEnabled };
  const setup = createWebgpuPagesSetup(context, diag);
  const layout = createWebgpuPagesLayout(setup);
  const vis = createWebgpuVisState();
  const run = createWebgpuRunState(context.clearColor);
  const blendState = createWebgpuBlendState();
  // The shadow pool's side, from the screen the world opens on: the first frame on the canvas
  // confirms or replaces it, before any page exists (`../shadow/poolSize.ts`).
  const lights = createWebgpuLightState(shadowPoolSide(...setup.viewport), context.sceneLights);
  const capabilities: BackendCapabilities = {
    renderer: 'WebGPU page raster',
    materials: UNTEXTURED_MATERIALS,
    hierarchy: true,
    gpuDriven: false,
    simplification: false,
    eviction: true,
    unsupported: [
      'material extensions, skinning and morph targets in WebGPU',
      'per-texture transforms, UV channels and sampler modes',
      'environment maps and light probes',
      'contract scene lights with shadow atlas',
      'indirect draw',
      'occlusion culling',
      'temporal occlusion culling',
      'small-triangle compute raster',
      'physical VRAM instrumentation',
      BOUNCE_CAPABILITY,
      MOTION_CAPABILITY,
      TAA_CAPABILITY,
      'sun shadows beyond the last clipmap level',
      'textured PBR maps',
      'visibility buffer',
      'direct WebGPU present',
    ],
  };
  const closer = new AbortController();
  const core: WebgpuPagesCore = {
    context,
    closer,
    signal: context.signal ? AbortSignal.any([context.signal, closer.signal]) : closer.signal,
    diag,
    setup,
    layout,
    gpu: createWebgpuGpuState(setup.viewport),
    vis,
    lights,
    bounce: createWebgpuBounceState(
      context.bounce === true,
      context.bounceBudgetMs ?? BOUNCE_SETTINGS.budgetMs,
    ),
    sunFar: createWebgpuSunFarState(),
    run,
    capture: createWebgpuCaptureState(),
    timing: createWebgpuTimingState(
      context.stageProfile ? createWebgpuStageProfiler() : undefined,
      layout.selectionRoots.length,
    ),
    capabilities,
    blendState,
  };
  return { ...core, services: createWebgpuPagesServices(core) };
}
