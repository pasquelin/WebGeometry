import { OPEN_CONE } from '../../../page/cone/cone.ts';
import { surfaceFrontOnly } from '../../../page/surface.ts';
import type { WebgpuPagesRuntime } from '../runtime.ts';

/** Every collected cluster carries the cone the compiler cooked (`Page.cone`), or the run-time cut
 *  built (`world/page/runtimeCut.ts`); this prepare posts each one, whether or not its indices are
 *  held yet — a streamed cluster and one drawn from its geometry page are culled like the others.
 *  Posting a cone is declaring it: the page's root raises its flag, or the cut would believe it has
 *  no cone and would no longer read `cone`. */
export function prepareCones(rt: WebgpuPagesRuntime) {
  for (const root of rt.setup.roots)
    for (const rec of root.pages) {
      if (!rec.cone) continue;
      root.cones = true;
      // Front-only alone keeps a closed cone, and the side is read from the declaration at this
      // very moment: a surface the host later opens in place reopens its cone at the cut
      // (`../../../page/surface.ts`, `gpuSelection.leafCone`).
      if (!surfaceFrontOnly(rec.material)) rec.cone = OPEN_CONE;
    }
}
