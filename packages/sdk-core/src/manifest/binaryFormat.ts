/**
 * Binary sidecar for a cluster manifest.
 *
 * A cluster cache describes tens of thousands of clusters with a dozen numbers each. Written as
 * JSON that is tens of megabytes the browser has to tokenize before the first frame; written as
 * typed-array columns it is a single `fetch` and a handful of views. The small JSON that stays
 * beside it keeps everything a human or a tool reads — primitives, materials, the group structure
 * counts, the bundle catalogue — plus the pointer to the columns.
 *
 * Layout, little-endian:
 *
 *   u32 magic 'WGMB' · u32 version · u32 columnCount · u32 reserved
 *   columnCount × (u32 byteOffset, u32 byteLength)
 *   column payloads, each starting on an 8-byte boundary
 *
 * Columns are fixed by version: their order, element type and stride are the format. Reading one
 * is `new Float64Array(buffer, offset, length/8)`, so decoding costs no parse at all.
 */
/** Version 4 turns the fixed 16×16 preview entries into the variable progressive levels: the pixel
 *  column has no stride any more, each entry naming its own byte range. A file of another version is
 *  refused whole: a reader that sliced the wrong range would show one texture's levels on another.
 *  Version 5 widens a preview entry from ten to twelve words — the atlas it serves and how many
 *  levels are baked as files under `textures/` — and its pixels follow the graphics card's mip rule;
 *  a version-4 reader would stride through the entries wrongly, so it refuses this file.
 *  Version 6 keeps every column and names another geometry page in the geometry descriptor: the
 *  quantized `WGP3` page (`geometryPage.ts`) in place of the float `WGP2` page, whose bytes a
 *  version-6 reader would refuse one by one at decode; refusing the file says it once.
 *  Version 7 widens a preview entry to fourteen words — the layout each block family holds the
 *  chain in, or none — and adds two columns: the tails block-compressed, BC family then ASTC,
 *  each kept entry's range following from its dimensions; a version-6 reader would not know
 *  them, so it refuses.
 *  Version 8 adds the page dependencies of the streaming bundles: a count per bundle, then the
 *  flat lists, closed up to the root cover (`docs/FORMAT.md` §Cluster DAG), that WebGPU requests
 *  and retains with a bundle. A version-7 reader cannot read the lists, so it refuses.
 *  Version 9 adds each page's normal cone, cooked by the compiler (`Page.cone`), in a column a
 *  version-8 reader lacks.
 *  Version 10 cuts the manifest into pages (`paged.ts`): a sidecar holds the columns of one page,
 *  the head's the texture previews alone. */
export const MANIFEST_BINARY_VERSION = 10;
/** The geometry-page format a version-10 sidecar names, as the manifest's `geometryPages` declares
 *  it once and every page header opens with. */
export const GEOMETRY_PAGE_FORMAT_VERSION = 3;
/** The codec geometry pages are written with. */
export const GEOMETRY_PAGE_CODEC = 'quantized';
/** 'W','G','M','B' read as a little-endian u32. */
export const MANIFEST_BINARY_MAGIC = 0x424d4757;
export const MANIFEST_BINARY_HEADER_WORDS = 4;

import { PREVIEW_WORDS } from '../texture/previewFormat.ts';
export * from '../texture/previewFormat.ts';
export * from './binaryPageWords.ts';

export const COLUMN_NAMES = [
  'pageBounds',
  'pageSphere',
  'pageParentSphere',
  'pageError',
  'pageInt',
  'pageU32',
  'pageSha',
  'geometrySha',
  'geometryU32',
  'cullingNodes',
  'groupLevel',
  'groupError',
  'groupSphere',
  'groupChildCount',
  'groupChild',
  'groupOutputCount',
  'groupOutput',
  'structureRoot',
  'bundleU32',
  'bundleSha',
  'pageDepthLayer',
  'texturePreviewU32',
  'texturePreviewSha',
  'texturePreviewPixels',
  'texturePreviewBc7',
  'texturePreviewAstc',
  'bundleDependencyCount',
  'bundleDependency',
  'pageCone',
] as const;
export type ColumnName = (typeof COLUMN_NAMES)[number];
/** How one column of the binary manifest is stored. */
export type ColumnKind = 'f64' | 'i32' | 'u32' | 'u8';
/**
 * How each column of the binary manifest is stored: decimals, whole numbers or bytes.
 * @property pageBounds - Each page's box.
 * @property pageSphere - Each page's ball.
 * @property pageParentSphere - The ball of what replaces each page.
 * @property pageError - Each page's error and its replacement's.
 * @property pageInt - Each page's signed numbers.
 * @property pageU32 - Each page's counts.
 * @property pageSha - Each page's fingerprint.
 * @property geometrySha - Each geometry block's fingerprint.
 * @property geometryU32 - Each geometry block's counts.
 * @property cullingNodes - The culling trees' nodes.
 * @property groupLevel - Each group's level.
 * @property groupError - Each group's error.
 * @property groupSphere - Each group's ball.
 * @property groupChildCount - How many clusters each group replaces.
 * @property groupChild - The clusters each group replaces.
 * @property groupOutputCount - How many clusters each group makes.
 * @property groupOutput - The clusters each group makes.
 * @property structureRoot - The clusters nothing replaces.
 * @property bundleU32 - Each bundle's counts.
 * @property bundleSha - Each bundle's fingerprint.
 * @property pageDepthLayer - Each page's coplanar depth layer.
 * @property texturePreviewU32 - Each texture preview's numbers.
 * @property texturePreviewSha - Each texture preview's fingerprint.
 * @property texturePreviewPixels - The previews' pixels.
 * @property texturePreviewBc7 - The previews' BC7 blocks.
 * @property texturePreviewAstc - The previews' ASTC blocks.
 * @property bundleDependencyCount - How many bundles each bundle depends on.
 * @property bundleDependency - The bundles each bundle depends on, closed to the root cover.
 * @property pageCone - Each page's normal cone: axis, then half-angle.
 */
export const COLUMN_KIND: Record<ColumnName, ColumnKind> = {
  pageBounds: 'f64',
  pageSphere: 'f64',
  pageParentSphere: 'f64',
  pageError: 'f64',
  pageInt: 'i32',
  pageU32: 'u32',
  pageSha: 'u8',
  geometrySha: 'u8',
  geometryU32: 'u32',
  cullingNodes: 'f64',
  groupLevel: 'i32',
  groupError: 'f64',
  groupSphere: 'f64',
  groupChildCount: 'i32',
  groupChild: 'i32',
  groupOutputCount: 'i32',
  groupOutput: 'i32',
  structureRoot: 'i32',
  bundleU32: 'u32',
  bundleSha: 'u8',
  pageDepthLayer: 'u32',
  texturePreviewU32: 'u32',
  texturePreviewSha: 'u8',
  texturePreviewPixels: 'u8',
  texturePreviewBc7: 'u8',
  texturePreviewAstc: 'u8',
  bundleDependencyCount: 'u32',
  bundleDependency: 'u32',
  pageCone: 'f64',
};
/** Numbers per element. A sha is 64 ASCII hexadecimal characters: one `TextDecoder` for the whole
 *  column, then one `substring` per entry, is far cheaper than re-encoding 32 raw bytes each time. */
export const COLUMN_STRIDE: Record<ColumnName, number> = {
  pageBounds: 6,
  pageSphere: 4,
  pageParentSphere: 4,
  pageError: 2,
  pageInt: 8,
  pageU32: 2,
  pageSha: 64,
  geometrySha: 64,
  geometryU32: 5,
  cullingNodes: 15,
  groupLevel: 1,
  groupError: 1,
  groupSphere: 4,
  groupChildCount: 1,
  groupChild: 1,
  groupOutputCount: 1,
  groupOutput: 1,
  structureRoot: 1,
  bundleU32: 2,
  bundleSha: 64,
  pageDepthLayer: 1,
  texturePreviewU32: PREVIEW_WORDS,
  texturePreviewSha: 64,
  // Columns without a fixed stride: their element is the byte, and their count is the total the
  // small JSON declares — each entry naming its own pixel range, and its block range following
  // from its dimensions, entry after entry.
  texturePreviewPixels: 1,
  texturePreviewBc7: 1,
  texturePreviewAstc: 1,
  bundleDependencyCount: 1,
  bundleDependency: 1,
  pageCone: 4,
};
export const BYTES_PER_ELEMENT: Record<ColumnKind, number> = { f64: 8, i32: 4, u32: 4, u8: 1 };

/** `pageInt` slots. -1 is «absent or null»; the flag word says which. */
export const INT_ID = 0,
  INT_LEVEL = 1,
  INT_GROUP = 2,
  INT_SOURCE = 3,
  INT_STREAM = 4,
  INT_STREAM_OFFSET = 5,
  INT_COUNT = 6,
  INT_START = 7;
/** `pageU32` slots. */
export const U32_BYTES = 0,
  U32_FLAGS = 1;
