import { SHADOW_CULL_FLOATS } from '../../../../sdk-core/src/index.ts';
import { SHADOW_CULL_CASTERS } from '../../../../sdk-core/src/scene/light-shadow/faces.ts';
import { DRAW_ALL, DRAW_FULL } from '../../../../sdk-core/src/scene/light-shadow/pool.ts';
import { SHADOW_PAGE } from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { MAX_SHADOW_REGIONS } from '../../gpu/shadow/atlas.ts';
import { CASTERS_ALL, CASTERS_MOVING, CASTERS_STATIC } from '../../gpu/shadow/cullShader.ts';

/** Where a region draws, and what it starts from: the pool page cleared to far, the pool page
 *  restored from the static layer, or the static layer's page cleared to far. */
export const REGION_CLEAR = 0,
  REGION_RESTORE = 1,
  REGION_STATIC = 2;

/**
 * THE FRAME'S REGIONS: what the depth pass draws, one or two per page. A page drawn in full keeps
 * its static casters in the static layer and the moving ones over a copy of it; a page whose moving
 * casters alone changed is the copy and the moving casters; without a static layer — nothing has
 * moved yet — a page is its casters, all at once. Each region names its physical page, its start
 * and the casters its cull keeps. Allocated once for a batch, on a pool of `poolSide`
 * pages a layer side: page `p` lies in layer `⌊p / poolSide²⌋`, as the shading reads it.
 */
export function createShadowRegionList(poolSide: number) {
  const layerPages = poolSide * poolSide,
    local = (region: number) => page[region] % layerPages;
  const page = new Int32Array(MAX_SHADOW_REGIONS),
    start = new Uint8Array(MAX_SHADOW_REGIONS);
  let count = 0,
    layered = 0;
  return {
    get count() {
      return count;
    },
    /** Regions that draw into the static layer: the pass that fills it runs only then. */
    get layered() {
      return layered;
    },
    reset() {
      count = 0;
      layered = 0;
    },
    pageOf: (region: number) => page[region],
    startOf: (region: number) => start[region],
    /** Viewport of a region: its physical page, one square and layer in pool and static layer. */
    x: (region: number) => (local(region) % poolSide) * SHADOW_PAGE,
    y: (region: number) => Math.floor(local(region) / poolSide) * SHADOW_PAGE,
    layer: (region: number) => Math.floor(page[region] / layerPages),
    /**
     * Appends the regions of physical page `phys` drawn in `mode` (`DRAW_*`), their caster words
     * in `volumeWords`. The first region's volume is written by the caller; a second one copies
     * it. Returns how many regions it took.
     */
    push(phys: number, mode: number, volumes: Float32Array, volumeWords: Uint32Array) {
      const first = count;
      const add = (from: number, casters: number) => {
        page[count] = phys;
        start[count] = from;
        if (count !== first)
          volumes.copyWithin(
            count * SHADOW_CULL_FLOATS,
            first * SHADOW_CULL_FLOATS,
            (first + 1) * SHADOW_CULL_FLOATS,
          );
        volumeWords[count * SHADOW_CULL_FLOATS + SHADOW_CULL_CASTERS] = casters;
        if (from === REGION_STATIC) layered++;
        count++;
      };
      if (mode === DRAW_ALL) add(REGION_CLEAR, CASTERS_ALL);
      else {
        if (mode === DRAW_FULL) add(REGION_STATIC, CASTERS_STATIC);
        add(REGION_RESTORE, CASTERS_MOVING);
      }
      return count - first;
    },
  };
}

export type ShadowRegionList = ReturnType<typeof createShadowRegionList>;
