/**
 * The progressive texture levels section of the binary sidecar — the entry words, the atlases,
 * the block families and their layouts —, beside `../manifest/binaryFormat.ts`, which owns the
 * columns and re-exports this.
 */
/** Progressive texture levels, mirrored by `packages/asset-compiler-rust/src/texture_preview.rs`:
 *  the tail of a source's mip chain in the sidecar, RGBA8 in the atlas's own encoding, from the
 *  finest level no side of which exceeds `PREVIEW_BASE` down to 1×1 — and, above it, one lossless
 *  PNG per level in the cache, `bakedLevels` of them from level 0 up. Every level follows the mip
 *  rule the card applied when it regenerated the chain itself (`packages/sdk-browser/src/texture/mips.ts`): linear mean of
 *  the colours, median alpha, level `k` from the quantized level `k - 1`. Their sizes are not
 *  written down: they follow from the source dimensions, which `previewLevels.ts` recomputes.
 *  Version 4 bakes every level above the tail, and the tail itself, in the block families the cook
 *  asked for beside the lossless files — the BC family for desktop cards, ASTC 4×4 for mobile ones,
 *  one byte per texel — for the chains a quality gate kept; a chain under the bar stays lossless
 *  in that family, and its entry's layout word says so. Version 5 counts the coverage-preserving
 *  chains' coverage on the filtered cut (#43), in the same layout. */
export const TEXTURE_PREVIEW_VERSION = 5;
/** `texturePreviewU32` slots. */
export const PREVIEW_TEXTURE = 0,
  PREVIEW_IMAGE = 1,
  PREVIEW_WIDTH = 2,
  PREVIEW_HEIGHT = 3,
  PREVIEW_SOURCE_KIND = 4,
  PREVIEW_SOURCE_VIEW = 5,
  PREVIEW_FIRST_LEVEL = 6,
  PREVIEW_LEVEL_COUNT = 7,
  PREVIEW_PIXEL_OFFSET = 8,
  PREVIEW_PIXEL_BYTES = 9,
  PREVIEW_ATLAS = 10,
  PREVIEW_BAKED_LEVELS = 11,
  /** One layout word per block family, `PREVIEW_BLOCK_FORMATS` order. */
  PREVIEW_LAYOUTS = 12;
export const PREVIEW_WORDS = 14;
/** A preview whose bytes came from an image `uri`; anything else names a glTF buffer view. */
export const PREVIEW_SOURCE_URI = 0;
/** The atlas a preview serves: colour (`rgba8unorm-srgb`, base colour and emissive) or data
 *  (`rgba8unorm`, metal-roughness, normal, occlusion). The same texture may have one entry each. */
export const PREVIEW_ATLAS_COLOR = 0,
  /** The data atlas: metal-roughness, normal and occlusion maps. */
  PREVIEW_ATLAS_DATA = 1,
  /** A chain of the colour atlas, for a texture every reader of which takes its alpha for coverage
   *  (the base colour of MASK or BLEND materials only): the one chain whose colours are weighted
   *  by alpha, named apart from the plain one (`reduce.rs`, `AtlasKind::Coverage`, #42). */
  PREVIEW_ATLAS_COVERAGE = 2;
/** The `{kind}` a baked level's path carries for each atlas, as `reduce.rs` names them; a coverage
 *  chain cut at byte C adds `-C`. */
export const PREVIEW_ATLAS_NAMES = ['srgb', 'linear', 'srgb-coverage'] as const;
/** The atlas of a word, its first byte: a coverage chain's cutoff fills the second. */
const atlasByte = (atlas: number) => atlas & 0xff;
/** The `{kind}` of an atlas word, `undefined` for a word no compiler writes. A coverage word's
 *  second byte is its cutoff byte `C`, whose share of covered texels every level keeps
 *  (`coverage.rs`, #44), and its chain is `srgb-coverage-C`; 0 when one of its readers blends, or
 *  when no byte reaches a reader's cutoff, and the chain keeps the median alone. */
export function previewAtlasName(atlas: number): string | undefined {
  if (!Number.isInteger(atlas) || atlas < 0 || atlas > 0xffff) return undefined;
  const cutoff = atlas >>> 8;
  if (cutoff === 0) return PREVIEW_ATLAS_NAMES[atlas];
  return atlasByte(atlas) === PREVIEW_ATLAS_COVERAGE
    ? `${PREVIEW_ATLAS_NAMES[PREVIEW_ATLAS_COVERAGE]}-${cutoff}`
    : undefined;
}
/** The cutoff byte of a coverage chain's word — 0 when it keeps the median alone —, `undefined`
 *  for any other chain. */
export const previewCoverageCutoff = (atlas: number) =>
  atlasByte(atlas) === PREVIEW_ATLAS_COVERAGE ? atlas >>> 8 : undefined;
/** The atlas an entry's chain is sampled in: a coverage chain is the colour atlas's. */
export const previewAtlasOf = (atlas: number) =>
  atlasByte(atlas) === PREVIEW_ATLAS_COVERAGE ? PREVIEW_ATLAS_COLOR : atlas;
/** The block families a chain may be baked in, in the order of their sidecar columns and of an
 *  entry's layout words, each named by its RGBA codec; `png` is the lossless file beside them. */
export const PREVIEW_BLOCK_FORMATS = ['bc7', 'astc'] as const;
/** A block family a texture can be baked in. */
export type TextureBlockFormat = (typeof PREVIEW_BLOCK_FORMATS)[number];
/** The lossless file format beside the block families. */
export const PREVIEW_LOSSLESS_FORMAT = 'png';
/** What a family holds of a chain, by layout word: nothing — the chain stays lossless there —,
 *  RGBA blocks (BC7 mode 6, ASTC colour endpoint mode 12), or two-channel blocks for a normal map
 *  (BC5, ASTC luminance + alpha on two planes: X in R, Y in G or A, Z rebuilt by the shader). */
export const PREVIEW_LAYOUT_NAMES = ['lossless', 'rgba', 'two-channel'] as const;
/** What a block family holds of a texture: nothing, colour blocks, or two-channel blocks. */
export type TextureLayout = (typeof PREVIEW_LAYOUT_NAMES)[number];
/** The `{format}` of a level file in each family and block layout, as `blocks.rs` names them. */
export const PREVIEW_LAYOUT_FILES: Record<
  TextureBlockFormat,
  Record<Exclude<TextureLayout, 'lossless'>, string>
> = {
  bc7: { rgba: 'bc7', 'two-channel': 'bc5' },
  astc: { rgba: 'astc', 'two-channel': 'astc-la' },
};
/** Texels along a block's side, and bytes of one block, in every format. */
export const PREVIEW_BLOCK_SIDE = 4;
/** Bytes of one block. */
export const PREVIEW_BLOCK_BYTES = 16;
