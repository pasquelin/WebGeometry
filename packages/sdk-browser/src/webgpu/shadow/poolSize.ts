import { createShadowPlan } from '../../../../sdk-core/src/index.ts';
import {
  shadowPoolSize,
  shadowPoolShape,
} from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { shadowCasterLights } from '../../../../sdk-core/src/scene/light-shadow/casters.ts';
import { shadowAtlasBytes } from '../../gpu/shadow/atlas.ts';
import { grantedShadowPool } from '../residency/poolGrants.ts';
import { startGrant } from '../../gpu/core/errorScope.ts';
import type { PoolClamp } from '../../residency/pools.ts';
import { createShadowRegionList } from './regions.ts';
import { createShadowPageRequests } from './pageRequests.ts';
import { SHADOW_ATLAS_BYTES } from '../../residency/memoryBudget.ts';
import type { WebgpuPagesRuntime } from '../pages/runtime.ts';
import type { WebgpuLightState } from '../pages/state/lights.ts';

/** The smallest shadow pool: the side a one-pixel screen asks (`shadowPoolSize`). */
const FLOOR_SIDE = shadowPoolShape(shadowPoolSize(1, 1)).side;

/** The shadow pool `budgetBytes` holds for a screen that asks `wanted` pages: the fewest layers
 *  that hold what fits, of the largest side that fits, never below the floor. */
export const shadowPoolFor = (wanted: number) => (budgetBytes: number) => {
  const pages = Math.min(wanted, Math.floor(budgetBytes / shadowAtlasBytes(1)));
  const { side: full, layers } = shadowPoolShape(pages),
    fits = Math.floor(Math.sqrt(budgetBytes / shadowAtlasBytes(1, layers)));
  const side = Math.max(Math.min(FLOOR_SIDE, shadowPoolShape(wanted).side), Math.min(full, fits));
  const clamp: PoolClamp =
    side <= FLOOR_SIDE ? 'minimum' : side * side * layers < wanted ? 'device-limit' : null;
  return { budgetBytes, side, layers, allocatedBytes: shadowAtlasBytes(side, layers), clamp };
};

/** GPU bytes the shadow pool holds: its buffers and depth pages, their transmittance and static
 *  layers once made, and its request buffer. */
export const shadowPoolHeld = ({ shadows, staticLayer, pageRequests }: WebgpuLightState) =>
  (shadows?.allocationBytes ?? 0) + (staticLayer?.bytes ?? 0) + (pageRequests?.bytes ?? 0);

/**
 * Sizes the shadow pool once, from the screen the first frame draws and the lights that cast a
 * shadow then, each counted over the whole screen (`shadowPoolSize`), granted at most the memory
 * budget's atlas bytes (`SHADOW_ATLAS_BYTES`): a world
 * may prepare on a canvas that is not laid out yet — the HTML default of 300 × 150, or the
 * session's default size — and only takes its real drawing buffer at its first frame. Until then
 * no shadow page exists, so the plan and the region list built at creation are replaced whole
 * when the side differs, keeping the host's settings. A capture's temporary size never sizes the
 * pool: the next frame on the canvas does. The budget is fixed from then on — a later resize does
 * not move it.
 *
 * The atlas texture is allocated under an out-of-memory check, like the geometry and texture pools
 * (`grantedShadowPool`): a pool the device refuses is drawn at half its bytes, down to the smallest
 * screen's side — coarser shadow pages —, and said under `gpu-out-of-memory`. Until the device
 * answers, the frame is held (`holdWebgpuFrame`) — the previous image stays, or nothing yet, never
 * one without its shadows — and a capture waits (`deviceAnswer`). When it refuses even the floor, the shadowed mode cannot be drawn: it
 * is refused by the `shadows-off` error, and the session goes on without shadows, never lost. A
 * world without a light that casts a shadow sizes nothing: its pool would hold no page. The first
 * frame that has one sizes it, before its plan maps any page.
 */
export function sizeShadowPool(rt: WebgpuPagesRuntime) {
  const { lights, capture, diag, run } = rt,
    atlas = lights.shadows,
    device = rt.gpu.device;
  if (!atlas || !device || atlas.texture || lights.shadowGrant) return;
  const casters = capture.capturing ? 0 : shadowCasterLights(lights.store);
  if (!casters) return;
  const viewport = [...rt.setup.viewport],
    wanted = shadowPoolSize(viewport[0], viewport[1], casters),
    shape = shadowPoolShape(wanted),
    asked = Math.min(shadowAtlasBytes(shape.side, shape.layers), SHADOW_ATLAS_BYTES),
    ceiled = asked < shadowAtlasBytes(shape.side, shape.layers);
  // The budget's ceiling, not the device, holds a pool drawn at `asked` short of `wanted`.
  const draw = (budgetBytes: number) => {
    const pool = shadowPoolFor(wanted)(budgetBytes);
    return ceiled && budgetBytes === asked && pool.clamp === 'device-limit'
      ? { ...pool, clamp: 'ceiling' as PoolClamp }
      : pool;
  };
  const granting = grantedShadowPool(device, asked, draw, diag.engineDiagnostic, (pool) =>
    atlas.makePool(pool.side, pool.layers),
  );
  const done = granting.then(
    (granted) => {
      if (!granted) {
        // Never silent: the image loses its shadows, and the page is told so by name, in the
        // diagnostic and in every frame's shadow report (`unavailable`).
        if (run.lost || rt.signal.aborted) return;
        lights.shadowReason = 'shadow pool refused by the device';
        diag.engineDiagnostic('shadows-off', 'The device refused the smallest shadow pool', {
          kind: 'error',
          reason: 'gpu-out-of-memory',
          requestedBytes: asked,
        });
        return;
      }
      // A session closed, or a device lost, while the device answered keeps nothing.
      if (run.lost || rt.signal.aborted || lights.shadows !== atlas) return granted.made.destroy();
      const { side, layers, clamp } = granted.pool;
      if (side !== lights.plan.pool.side || layers !== lights.plan.pool.layers) {
        const before = lights.plan;
        lights.plan = createShadowPlan(side, layers);
        lights.plan.setPageInvalidation(before.pageInvalidation);
        lights.regions = createShadowRegionList(side);
      }
      atlas.sizePool(side, layers, granted.made);
      lights.pageRequests = createShadowPageRequests(device, lights.plan.pool.pages);
      diag.engineDiagnostic('shadow-pool', 'Shadow pool sized from the first frame', {
        version: 1,
        viewport,
        side,
        layers,
        pages: lights.plan.pool.pages,
        bytes: shadowAtlasBytes(side, layers),
        clamp,
      });
      run.gate.resourcesChanged();
    },
    (error: unknown) => {
      if (!run.lost && !rt.signal.aborted) diag.diagnosticFailure('shadow-pool-unavailable', error);
    },
  );
  lights.shadowGrant = startGrant(done);
}
