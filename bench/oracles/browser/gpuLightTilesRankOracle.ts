/**
 * Oracle D4: a line-by-line port of the batched compaction of `lightTiles` in
 * packages/sdk-browser/src/lighting/tiles/shader.ts. The scene's lights are tested 256 at a time,
 * one per thread; each thread, in any order, writes its kept light at what the batches before
 * kept plus the rank `rankBefore` reads from the batch's mask while that rank is within the
 * list's `TILE_LIGHTS`, and thread zero writes the two true counts once every batch is done. A
 * count past `TILE_LIGHTS` makes the reader walk every light (`tileLighting`).
 *
 * The tile layout is read from the shader's own WGSL constants, never restated here, so a shader whose
 * record has no room for a light it keeps fails the port: a write that leaves its list lands in
 * the neighbouring list or tile on the GPU, and throws here.
 */

export type TileLayout = {
  threads: number;
  tileLights: number;
  stride: number;
  opaqueBase: number;
  blendBase: number;
  opaqueMask: number;
  blendMask: number;
  words: number;
};

function wgslConstant(shader: string, name: string) {
  const found = new RegExp(`const ${name}:u32=(\\d+)u;`).exec(shader);
  if (!found) throw new Error(`the tile shader declares no ${name}`);
  return Number(found[1]);
}

/** The tile record layout the shader declares. */
export function tileLayout(shader: string): TileLayout {
  const tileSize = wgslConstant(shader, 'TILE_SIZE');
  const opaqueMask = wgslConstant(shader, 'OPAQUE_MASK');
  const blendMask = wgslConstant(shader, 'BLEND_MASK');
  return {
    threads: tileSize * tileSize,
    tileLights: wgslConstant(shader, 'TILE_LIGHTS'),
    stride: wgslConstant(shader, 'TILE_STRIDE'),
    opaqueBase: wgslConstant(shader, 'TILE_OPAQUE_BASE'),
    blendBase: wgslConstant(shader, 'TILE_BLEND_BASE'),
    opaqueMask,
    blendMask,
    words: blendMask - opaqueMask,
  };
}

const countOneBits = (word: number) => {
  let w = word >>> 0,
    n = 0;
  while (w) {
    n += w & 1;
    w >>>= 1;
  }
  return n;
};

function rankBefore(hits: Uint32Array, mask: number, lane: number) {
  const word = mask + (lane >>> 5);
  let rank = 0;
  for (let before = mask; before < word; before++) rank += countOneBits(hits[before]);
  return rank + countOneBits(hits[word] & ((1 << (lane & 31)) - 1));
}

const maskHolds = (hits: Uint32Array, mask: number, lane: number) =>
  ((hits[mask + (lane >>> 5)] >>> (lane & 31)) & 1) === 1;

function maskTotal(hits: Uint32Array, layout: TileLayout, mask: number) {
  let total = 0;
  for (let w = 0; w < layout.words; w++) total += countOneBits(hits[mask + w]);
  return total;
}

/** The lights each slice of the tile keeps, by rank in the scene. */
export type TileKeeps = { opaque: Iterable<number>; blend: Iterable<number> };

/**
 * One tile's record after the compaction of `lightCount` lights, of which each slice keeps those
 * `keeps` names. `lanes` is the order the threads run in, within each batch.
 */
export function compactTile(
  layout: TileLayout,
  keeps: TileKeeps,
  lightCount: number,
  lanes: Iterable<number> = Array.from({ length: layout.threads }, (_, lane) => lane),
): Uint32Array {
  const tiles = new Uint32Array(layout.stride);
  const write = (start: number, end: number, index: number, value: number) => {
    if (index < start || index >= end)
      throw new RangeError(`write at ${index} leaves its list [${start}, ${end})`);
    tiles[index] = value;
  };
  const opaque = new Set(keeps.opaque),
    blend = new Set(keeps.blend),
    order = [...lanes],
    hits = new Uint32Array(2 * layout.words);
  let opaqueKept = 0,
    blendKept = 0;
  for (let first = 0; first < lightCount; first += layout.threads) {
    hits.fill(0);
    for (let lane = 0; lane < layout.threads && first + lane < lightCount; lane++) {
      const bit = 1 << (lane & 31);
      if (opaque.has(first + lane)) hits[layout.opaqueMask + (lane >>> 5)] |= bit;
      if (blend.has(first + lane)) hits[layout.blendMask + (lane >>> 5)] |= bit;
    }
    for (const lane of order) {
      const index = first + lane;
      const opaqueAt = opaqueKept + rankBefore(hits, layout.opaqueMask, lane);
      if (
        index < lightCount &&
        maskHolds(hits, layout.opaqueMask, lane) &&
        opaqueAt < layout.tileLights
      )
        write(layout.opaqueBase, layout.blendBase, layout.opaqueBase + opaqueAt, index);
      const blendAt = blendKept + rankBefore(hits, layout.blendMask, lane);
      if (
        index < lightCount &&
        maskHolds(hits, layout.blendMask, lane) &&
        blendAt < layout.tileLights
      )
        write(layout.blendBase, layout.stride, layout.blendBase + blendAt, index);
    }
    opaqueKept += maskTotal(hits, layout, layout.opaqueMask);
    blendKept += maskTotal(hits, layout, layout.blendMask);
  }
  write(0, layout.opaqueBase, 0, opaqueKept);
  write(0, layout.opaqueBase, 1, blendKept);
  return tiles;
}

/** The lights a pixel of the tile walks in each slice: its list, or every light of the scene
 *  when the count passes `TILE_LIGHTS` (`tileLighting` of the resolve). */
export function tileLists(layout: TileLayout, tiles: Uint32Array, lightCount: number) {
  const walk = (count: number, base: number) =>
    count <= layout.tileLights
      ? [...tiles.subarray(base, base + count)]
      : Array.from({ length: lightCount }, (_, index) => index);
  return { opaque: walk(tiles[0], layout.opaqueBase), blend: walk(tiles[1], layout.blendBase) };
}
