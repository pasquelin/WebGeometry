import { FLAG_BLEND_CASTER, FLAG_MASK, PAGE_INFO_STRIDE } from '../../../visibility/buffer.ts';
import type { DirectLightResources } from '../../../lighting/deferred/program.ts';
import type { PageRec } from '../../../page/selection/selection.ts';
import { ROW_FLAGS_WORD, ROW_MAP_LAYER_WORD } from '../../row/pageRow.ts';
import type { WebgpuPagesRuntime } from '../runtime.ts';
import type { WebgpuLightState } from '../state/lights.ts';
import { boxEmpty } from '../../../../../sdk-core/src/index.ts';
import { changeBox, changeMax, changeMin, growClusterBox } from '../../shadow/bounds.ts';

const EVERYWHERE_MIN = [-1e30, -1e30, -1e30],
  EVERYWHERE_MAX = [1e30, 1e30, 1e30];
const ROW_WORDS = PAGE_INFO_STRIDE / 4;
/** The rows whose shadow reads their colour map's alpha: a cutout's, and a blended caster's. */
const ALPHA_READERS = FLAG_MASK | FLAG_BLEND_CASTER;

/** The page-table rows the invalidation reads: their words, and the record each row draws. */
interface ShadowRowTable {
  rowCount: number;
  /** The blended casters' rows, `[blendFirst, casterSlots)`. */
  blendFirst: number;
  casterSlots: number;
  pageTableInts: Uint32Array | undefined;
  packedRecs: ArrayLike<PageRec | undefined>;
}

/**
 * Colour tiles of textures `slots` are resident, or have left: the alpha cutout the shadow pass
 * reads has just changed for every masked surface that carries one of these textures — and the
 * coverage of every blended caster that does (`../../../gpu/shadow/transmittance.ts`) —, and a
 * map drawn at the previous level would describe foliage that is no longer the image's. The
 * pages the world box of those surfaces covers go back to waiting once the camera rests, under
 * the ordinary Shadows stage budget — and those alone: a colour tile of a texture no cutout
 * reads changes no depth, and stales nothing. One scan of the page table per pump, whatever
 * the tiles served. At `-1` the pool changed without naming a texture — a resize — and every
 * page restarts. Without this signal, two identical runs produced two different shadows,
 * depending on when each page had been drawn.
 */
export function shadowsFollowTextures(
  lights: WebgpuLightState,
  rows: ShadowRowTable,
  slots: ReadonlySet<number> | -1,
) {
  if (!lights.store.count) return;
  if (slots === -1) {
    lights.plan.representationChanged(EVERYWHERE_MIN, EVERYWHERE_MAX);
    return;
  }
  const ints = rows.pageTableInts;
  if (!ints || !slots.size) return;
  boxEmpty(changeBox, 0);
  const touched =
    growAlphaReaders(ints, rows, slots, 0, rows.rowCount) |
    growAlphaReaders(ints, rows, slots, rows.blendFirst, rows.casterSlots);
  if (touched) lights.plan.representationChanged(changeMin, changeMax);
}

/** Grows the change box by rows `[from, to)` whose shadow reads the alpha of a map of `slots`;
 *  1 when one did. */
function growAlphaReaders(
  ints: Uint32Array,
  rows: ShadowRowTable,
  slots: ReadonlySet<number>,
  from: number,
  to: number,
) {
  let touched = 0;
  for (let row = from; row < to; row++) {
    const base = row * ROW_WORDS;
    if (
      !(ints[base + ROW_FLAGS_WORD] & ALPHA_READERS) ||
      !slots.has(ints[base + ROW_MAP_LAYER_WORD])
    )
      continue;
    const rec = rows.packedRecs[row];
    if (!rec) continue;
    growClusterBox(rec, changeBox);
    touched = 1;
  }
  return touched;
}

/**
 * The threshold the light cuts select casters at: the camera's. The plan keeps the one each page
 * was drawn at, and redraws, once the camera rests, only the pages drawn at another
 * (`thresholds.ts`). Returns the threshold.
 */
export function followLightThreshold(lights: WebgpuLightState, pixelError: number) {
  lights.plan.setThreshold(pixelError);
  return pixelError;
}

/**
 * Serves tiles requested by the previous image, except during a pose barrier: the shadow
 * drain replays the image without admitting new ones. An arriving tile invalidates every
 * map (`shadowsFollowTextures`) and the queue would never empty (#25).
 */
export function pumpResidentTiles(
  textures: { pump: (frame: number) => void } | undefined,
  frame: number,
  converging: boolean,
) {
  if (!converging) textures?.pump(frame);
}

/**
 * True when the image must be lit by the declared lights. False in the only unlit view: `unlit`
 * requested by the host, or `auto` on a scene with no light — there, raw albedo comes out as-is.
 *
 * The light count does not enter the decision. An explicitly requested `lit` view lights even with
 * no light: the contract then outputs black, emissives kept, and that is the right answer — a scene
 * no source lights is black. Falling back to albedo made a room bright when the host had just turned
 * off all its lights, with no blackout showing.
 */
export function wantsContractLighting(rt: WebgpuPagesRuntime) {
  return !rt.lights.store.unlit;
}

/** The deferred lighting while the image wants the contract but still resolves unlit — its
 *  program compiles, and its arrival changes the image —, else nothing. */
export function compilingContract(rt: WebgpuPagesRuntime) {
  const { deferred } = rt.gpu;
  return deferred && wantsContractLighting(rt) && !deferred.usesContract ? deferred : undefined;
}

const contractResources: DirectLightResources = {};

/**
 * Contract resources the deferred pass binds, or nothing when they do not exist. Each is returned as
 * it is held elsewhere, never copied or rebuilt: the pass compares what it is given to what it has
 * bound, and rebuilds its bind group only if that has changed. The object itself is reused from one
 * image to the next: the pass allocates nothing.
 */
export function directLightResources(rt: WebgpuPagesRuntime) {
  const { lights } = rt,
    active = wantsContractLighting(rt);
  contractResources.lights = lights.buffer;
  contractResources.tiles = active ? lights.tiles?.buffer : undefined;
  contractResources.slices = active ? lights.shadows?.dataBuffer : undefined;
  contractResources.requests = active ? lights.shadows?.requestBuffer : undefined;
  contractResources.atlas = active ? lights.shadows?.view : undefined;
  contractResources.transmittance = active ? lights.shadows?.transmittance : undefined;
  // The grid is bound only if it exists: without it, the deferred pass compiles and binds the
  // contract program alone, exactly the one from before the bounce lot.
  const bounce = active && rt.bounce.wanted ? rt.bounce.probes : undefined;
  contractResources.bounceGrid = bounce?.uniform;
  contractResources.probes = bounce?.probes;
  contractResources.surfaceCache = bounce?.surface.buffer;
  // Far-shadow proxy: bound only if it exists, otherwise the zero replacements leave the far surface
  // lit with no cast shadow. Both lighting passes read this same resolve, so they bind the same
  // buffer and trace the same ray.
  contractResources.proxy = active ? rt.sunFar.gpu?.buffer() : undefined;
  return contractResources;
}
