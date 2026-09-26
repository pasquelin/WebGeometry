import { LIGHT_KIND, LIGHT_SETTINGS, MAX_SHADOW_SLICES, POINT_FACES } from '../light/contracts.ts';

/**
 * THE VIRTUAL LAYOUT OF SHADOW MAPS: what a page of each light is, and where its word sits in
 * the page table. Pure arithmetic, shared by the scheduler and — through the constants it
 * exports — by the shaders, so the two can never address a page differently.
 *
 * - A **sun** has `SUN_LEVELS` clipmap levels. Level `L` has texels of `2^L` metres and an extent
 *   of `SUN_WINDOW²` pages around the camera, addressed by absolute page modulo the extent — a
 *   ring: a camera step keeps every page that stays inside. The level itself sits in slot
 *   `L mod SUN_LEVELS`, a ring too, so a change of the finest level keeps the others.
 * - A **lamp** face — six for a point, one for a spot — is a map of `LAMP_SIDE²` pages at its
 *   finest mip, with every coarser mip down to one page.
 *
 * The physical pool is the one size here that depends on the world: `shadowPoolSize`.
 */
/** Side of a shadow page, in texels: the unit of the pool, of the virtual maps and of invalidation. */
export const SHADOW_PAGE: number = LIGHT_SETTINGS.shadowPage;
/** Pages per side of a lamp face's finest mip. */
export const LAMP_SIDE = Math.floor(LIGHT_SETTINGS.lampFaceSize / SHADOW_PAGE);
export const SUN_LEVELS: number = LIGHT_SETTINGS.sunLevels;
export const SUN_WINDOW: number = LIGHT_SETTINGS.sunLevelPages;
/** Mips of a lamp face, from `LAMP_SIDE` pages per side down to one. */
export const LAMP_MIPS = Math.log2(LAMP_SIDE) + 1;
/** Pages a side of a sun's `2W × 2H` texel rectangle: one per `P / 2` screen pixels. */
const tiles = (pixels: number) => Math.ceil((2 * Math.max(1, pixels)) / SHADOW_PAGE);
/** Pages one light reads in a frame over a smooth `w × h` screen, `c` the share of its pixels
 *  that read that light (1 for a sun): its texel rectangle, and a third more while pages wait. */
const lightPages = (w: number, h: number, c: number) =>
  Math.ceil((4 * c * tiles(w) * tiles(h)) / 3);
/** The pool the first frame asks: every shadowed light's read, twice — the report the pool holds
 *  and the next one, which a turn of the camera may renew in full. */
export function priorPoolPages(w: number, h: number, coverage: ArrayLike<number>) {
  let sum = 0;
  for (let i = 0; i < coverage.length; i++) sum += lightPages(w, h, coverage[i]);
  return 2 * sum;
}
/**
 * Physical pages of the shadow pool, for a `width × height` screen and the screen share each
 * shadowed light is read over (`coverage`): a fixed budget, derived once from the screen the first
 * frame draws, never read off the machine.
 *
 * What one frame reads. A pixel reads ONE sun level — the one whose texel is at most its
 * footprint and more than half of it — around one point, the PCF taps a few texels wide. A page
 * of that level is `P` texels, so more than `P / 2` of the footprints that read it: a tile of
 * `P / 2 × P / 2` screen pixels lying on one surface lands in light space inside `P × P` texels —
 * projection on the light's plane never lengthens a distance — and reads at most the 2 × 2 pages
 * such a square straddles, its PCF border included: four pages a tile. A pixel whose page is not
 * drawn yet reads — and asks for — the next coarser level instead, whose pages each cover four of
 * the finer: while pages wait, the requests grow by at most a quarter, a sixteenth, … — a third.
 * So a frame asks for at most `⁴⁄₃ · 4 · ⌈2W / P⌉ · ⌈2H / P⌉` pages.
 *
 * That bound is exact for a tile on one surface at one level, and loose everywhere else by the
 * same count: two tiles side by side on one floor share their pages, so a smooth screen reads a
 * quarter of it (a `2W × 2H` texel rectangle). What a tile loses at an edge — a level switch, a
 * silhouette whose two sides read two places of the map — its smooth neighbours leave free.
 * Named approximation: a screen where most tiles straddle an edge (dense foliage) can read more;
 * the pages past the pool wait a frame, read at the coarser level meanwhile.
 *
 * The request that asks for a frame's pages comes back a frame later, and the pages the latest
 * report named are never taken (`pool.ts`): the pool holds that report's pages and the next
 * report's — twice a frame's read (`priorPoolPages`). The static layer mirrors the pool page for
 * page (`gpu/shadow/staticLayer.ts`), so it adds bytes, never pages.
 *
 * The pool holds the worst-case bound while it fits one layer, and the smooth read of every
 * shadowed light past it. At 1280 × 720: 20 × 12 tiles, 1 280 pages a frame at worst, 2 560 held —
 * 51 × 51 pages, a 6 528² depth texture of 163 MiB. At 3 456 × 2 234 with one sun: 54 × 35 tiles,
 * 2 520 pages a frame, 5 040 held — two layers of 51 × 51 pages. The only limits are the device's
 * and the memory grant (`webgpu/shadow/poolSize.ts`).
 */
export function shadowPoolSize(width: number, height: number, coverage: ArrayLike<number> = [1]) {
  const worst = 2 * Math.ceil((4 * 4 * tiles(width) * tiles(height)) / 3);
  return Math.max(Math.min(worst, LAYER_PAGES), priorPoolPages(width, height, coverage));
}
/** Entries a request report lists, for a pool of `pages`: never fewer than the pool holds — a full
 *  list names every page the pool can keep. */
export const shadowRequestCap = (pages: number) => Math.max(LIGHT_SETTINGS.shadowRequestCap, pages);
/** Entries of a sun level, of a whole sun, of one lamp face (every mip). */
export const SUN_LEVEL_ENTRIES = SUN_WINDOW * SUN_WINDOW;
export const SUN_ENTRIES = SUN_LEVELS * SUN_LEVEL_ENTRIES;
export const LAMP_FACE_ENTRIES = (() => {
  let total = 0;
  for (let mip = 0; mip < LAMP_MIPS; mip++) total += (LAMP_SIDE >> mip) ** 2;
  return total;
})();
/** Words of the page table each slice owns: the largest range a light needs, a whole sun or a
 *  point light's six faces — so a slice of any kind always finds its span. */
export const SHADOW_TABLE_STRIDE = Math.max(SUN_ENTRIES, POINT_FACES * LAMP_FACE_ENTRIES);
/** Words of the whole page table: one span per shadow slice, one slice per light. */
export const SHADOW_TABLE_ENTRIES = MAX_SHADOW_SLICES * SHADOW_TABLE_STRIDE;
/** A table word: the physical page in the low bits, `PAGE_MAPPED` while it holds one, and
 *  `PAGE_VALID` while its depth may be read — set once its draw has landed, cleared while what it
 *  holds is wrong and waits to be drawn again (`pool.withdraw`). A page not valid hands the point
 *  to the next coarser level. */
export const PAGE_VALID = 1 << 16;
export const PAGE_MAPPED = 1 << 17;
export const PAGE_INDEX_MASK = 0xffff;
/** Pages a side of one layer of the pool: an 8 192-texel square, the largest 2D texture side
 *  WebGPU guarantees on every device (the default `maxTextureDimension2D`). */
const LAYER_SIDE = Math.floor(8192 / SHADOW_PAGE);
export const LAYER_PAGES = LAYER_SIDE * LAYER_SIDE;
/** Layers the page index addresses (`PAGE_INDEX_MASK`): 16 of 4 096 pages. */
export const MAX_LAYERS = (PAGE_INDEX_MASK + 1) / LAYER_PAGES;
/** The fewest whole layers that hold `pages`, each the smallest square that shares them out. Page
 *  `p` lies in layer `⌊p / side²⌋`: one layer is the one square the pool always was. */
export function shadowPoolShape(pages: number) {
  const wanted = Math.min(Math.max(1, Math.ceil(pages)), MAX_LAYERS * LAYER_PAGES);
  const layers = Math.ceil(wanted / LAYER_PAGES);
  return { side: Math.ceil(Math.sqrt(wanted / layers)), layers };
}

/** Non-negative remainder. */
export const ringOf = (value: number, size: number) => ((value % size) + size) % size;

/** Pages per side of a lamp face at `mip`. */
export const lampPagesAt = (mip: number) => LAMP_SIDE >> mip;

/** First entry of `mip` inside a lamp face. */
export function lampMipOffset(mip: number) {
  let offset = 0;
  for (let m = 0; m < mip; m++) offset += lampPagesAt(m) ** 2;
  return offset;
}

/** Faces a lamp of kind `rank` draws: six for a point, one for a spot. */
export const lampFacesOf = (rank: number) => (rank === LIGHT_KIND.point ? POINT_FACES : 1);

/** Table entries a light of kind `rank` needs: a whole sun, or its lamp faces. */
export function tableEntriesOf(rank: number) {
  if (rank === LIGHT_KIND.directional) return SUN_ENTRIES;
  return lampFacesOf(rank) * LAMP_FACE_ENTRIES;
}

/** Entry of sun page `(ax, ay)` of level `level`, relative to the light's table base. */
export const sunEntry = (level: number, ax: number, ay: number) =>
  ringOf(level, SUN_LEVELS) * SUN_LEVEL_ENTRIES +
  ringOf(ay, SUN_WINDOW) * SUN_WINDOW +
  ringOf(ax, SUN_WINDOW);

/** Entry of lamp page `(x, y)` of `face` at `mip`, relative to the light's table base. */
export const lampEntry = (face: number, mip: number, x: number, y: number) =>
  face * LAMP_FACE_ENTRIES + lampMipOffset(mip) + y * lampPagesAt(mip) + x;

/** What a relative lamp entry names: face, mip and page, written into `out`. */
export function decodeLampEntry(relative: number, out: Int32Array) {
  const face = Math.floor(relative / LAMP_FACE_ENTRIES);
  let rest = relative - face * LAMP_FACE_ENTRIES,
    mip = 0;
  while (mip < LAMP_MIPS - 1 && rest >= lampPagesAt(mip) ** 2) rest -= lampPagesAt(mip++) ** 2;
  const pages = lampPagesAt(mip);
  out[0] = face;
  out[1] = mip;
  out[2] = rest % pages;
  out[3] = Math.floor(rest / pages);
  return out;
}

/**
 * How coarse a page is within its light, on one scale for every light: a sun level's steps above
 * its finest level over the sun's `SUN_LEVELS`, a lamp's mip over its `LAMP_MIPS` — both brought
 * to whole steps of their common denominator, `SUN_LEVELS · LAMP_MIPS`. A sun's clipmap and a
 * lamp's mip chain count different things; each light's own span makes their ranks comparable.
 */
export const sunCoarseness = (level: number, finest: number) => (level - finest) * LAMP_MIPS;
export const lampCoarseness = (mip: number) => mip * SUN_LEVELS;

/** A light's floor, the last level a reader falls back to: a sun's coarsest clipmap level, and a
 *  lamp face's one-page mip. */
export const sunFloorLevel = (finest: number) => finest + SUN_LEVELS - 1;
export const LAMP_FLOOR_MIP = LAMP_MIPS - 1;

/** Side of a sun page at `level`, in metres: 128 texels of `2^level`. */
export const sunPageMetres = (level: number) => SHADOW_PAGE * 2 ** level;

/**
 * The finest level a pixel of this view can read: the texel at most the size of its footprint
 * at the near plane. Every finer level would be sharper than any pixel that reads it.
 */
export const finestSunLevel = (pixelNear: number) =>
  Math.floor(Math.log2(Math.max(pixelNear, Number.MIN_VALUE)));
