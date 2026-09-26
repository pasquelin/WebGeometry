import { BOUNCE_SETTINGS, type SceneProxy } from '../../../../../sdk-core/src/index.ts';
import { bounceProbeBytes } from '../../../bounce/limits.ts';
import { createGpuBounceProbes } from '../../../bounce/probes.ts';
import { grantCapability } from '../io/drops.ts';
import type { WebgpuPagesRuntime } from '../runtime.ts';

/** What the capability declares while bouncing light is not rigged on this device. */
export const BOUNCE_CAPABILITY = 'global illumination and surface cache';
/** Named approximations of the bounce, published in the diagnostic (P5). */
const BOUNCE_APPROXIMATIONS = [
  'the cascades interpolate irradiance between eight probes, so a detail smaller than a cell is lost',
  'order-2 spherical harmonics carry the irradiance, so a sharp directional change is smoothed',
  'probe visibility uses six mean distances per probe, not a full distance map',
  'the resident proxy carries a certified geometric error, so a bounce leaves the coarse surface',
  'the proxy carries diffuse albedo only: emission, transparency and specular are not bounced',
  'a probe update reads the cascades as they stand, so one update may see a neighbour already updated',
  'a probe ray that exhausts the published traversal bound reports no hit, which darkens',
  'a shadow ray that exhausts that bound reports no blocker, which lights a cell that should be dark',
  'the surface cache holds one radiance per proxy triangle and face, so lighting is constant over a cell',
  'the surface cache is swept on a budget, so a freshly moved light reaches a cell within one sweep',
  'a probe buried in a surface or lost in open sky goes to sleep and is skipped until a light changes',
  'the millisecond budget follows a timestamp read several frames late, and only every third or twelfth frame',
  'a point no cascade level reaches gets exactly zero bounce, never a guess',
];

/** Why there is no bounce while the host has not asked for it: the one reason a toggle lifts. */
const BOUNCE_OFF = 'the bounce is off by default; create the explorer with bounce: true';

/**
 * Turns bouncing light on or off during the session. Off, the grid stops being updated and read,
 * and is kept; on again, it is rigged at the next image that carries a lamp (`ensureBounce`) or
 * read again as it stands — no program, table or pool is rebuilt either way.
 */
export function setWebgpuBounce(rt: WebgpuPagesRuntime, on: boolean) {
  const { bounce } = rt;
  if (bounce.wanted === on) return;
  bounce.wanted = on;
  if (on && bounce.reason === BOUNCE_OFF) bounce.reason = null;
  rt.run.gate.resourcesChanged();
}

/**
 * Rigs bouncing light, at the first image that carries a declared lamp.
 *
 * Nothing is loaded before: a scene without a lamp has nothing to bounce, and the proxy's cache
 * object weighs tens of megabytes that would delay its first image for nothing. Once it arrives,
 * the proxy goes into GPU memory whole and the probe grid is allocated on its extent —
 * independent of the camera, like the proxy itself (LC1).
 *
 * Everything is optional: a cache without a proxy, a device that refuses the pass or a host that
 * does not want it keep a correct image and a declared missing capability. Nothing is dropped in
 * silence.
 */
export function ensureBounce(rt: WebgpuPagesRuntime, device: GPUDevice) {
  const { bounce, lights, context } = rt;
  if (bounce.probes || bounce.pending || bounce.reason) return;
  if (!bounce.wanted) bounce.reason = BOUNCE_OFF;
  else if (!context.readSceneProxy)
    bounce.reason = 'the cache carries no resident proxy; recompile it with this compiler';
  else if (!lights.buffer) bounce.reason = 'the declared-light buffer is unavailable';
  if (bounce.reason) {
    publish(rt);
    return;
  }
  bounce.pending = context.readSceneProxy!()
    .then((proxy: SceneProxy) =>
      createGpuBounceProbes(device, proxy, () => lights.buffer!, bounce.budgetMs),
    )
    .then(
      (probes) => {
        bounce.probes = probes;
        grantCapability(rt.capabilities, BOUNCE_CAPABILITY);
        publish(rt);
      },
      (error: unknown) => {
        // A missing proxy is no longer the only cause: a device too small for the bounce bindings
        // refuses here too, and the message carries the binding and the bytes that were missing.
        bounce.reason = `bounce unavailable: ${String(error)}`;
        rt.diag.diagnosticFailure('bounce-unavailable', error);
        publish(rt);
      },
    );
}

/** What the bounce actually obtained: proxy size, grid, budget. Never an estimate. */
function publish(rt: WebgpuPagesRuntime) {
  const { bounce, diag } = rt,
    probes = bounce.probes;
  diag.engineDiagnostic('bounce-lighting', 'Bouncing light rigged', {
    version: 1,
    settings: { ...BOUNCE_SETTINGS },
    proxyTriangles: probes?.proxy.triangleCount ?? null,
    proxyNodes: probes?.proxy.nodeCount ?? null,
    proxyBytes: probes?.proxy.bytes ?? null,
    proxyErrorMetres: probes?.proxy.errorMetres ?? null,
    proxyCellMetres: probes?.proxy.cellMetres ?? null,
    surfaceTexels: probes?.surface.texels ?? null,
    surfaceBytes: probes?.surface.bytes ?? null,
    surfaceSweepFrames: probes?.surface.sweepFrames ?? null,
    cascadeLevels: probes?.cascades.levels.length ?? null,
    cascadeSize: probes?.cascades.size ?? null,
    cascadeSpacings: probes?.cascades.levels.map((level) => level.spacing) ?? null,
    probes: probes?.cascades.probes ?? null,
    // What the occupancy map keeps: the finest-level cells that touch geometry, over all those
    // of the extent, and what the map costs in memory.
    occupiedCells: probes?.occupancy.marked ?? null,
    mapCells: probes?.occupancy.cells ?? null,
    mapBytes: probes?.occupancy.bytes ?? null,
    probeBytes: probes ? bounceProbeBytes(probes.cascades.probes) : null,
    // The target, the fraction the servo holds, and the last duration it saw.
    budgetMs: probes?.budget.budgetMs ?? bounce.budgetMs,
    budgetLoad: probes?.budget.load ?? null,
    budgetLastMs: probes?.budget.lastMs ?? null,
    budgetSamples: probes?.budget.samples ?? null,
    sweepFrames: probes?.sweepFrames ?? null,
    unavailable: bounce.reason,
    approximations: BOUNCE_APPROXIMATIONS,
  });
}
