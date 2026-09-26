import type { Texture } from '../../../../sdk-core/src/index.ts';
import { texelsRefusal, textureRgba } from '../../visibility/types.ts';
import { premultipliedByte } from '../../visibility/math.ts';
import { generateMaterialMips } from '../../texture/mips.ts';
import { mipLevelCountFor } from '../../texture/tiles.ts';
import type { CoverageReaders } from '../../texture/coverage.ts';
import { writeRgba } from './write.ts';
import { textureBytesOf } from '../../gpu/core/deviceLedger.ts';

/**
 * Working texture of a host texture: the whole source, transferred once, and its mip chain built
 * by the GPU with the materials rule (mean in colour, weighted by alpha where every reader takes
 * alpha for coverage, median in alpha, scaled at the readers' cutoff). Tiles are then copied into the pool, level by level.
 *
 * This is the path of a texture WITHOUT a cooked chain — one a host decoded itself, or a test
 * scene that gives its texels in memory. It costs the whole source every time a tile of that
 * texture is missing, and that is intended: GPU memory held stays that of the pool, and the
 * price is paid in transfer, measured, never in resident bytes. The cache's cooked chain is the
 * reference path; this one exists only so that no scene is refused. A LIVE texture — one whose
 * picture moved since the session opened: a video, a canvas redrawn — keeps its working texture,
 * one of its own size, refilled in place at each new picture (`fill`, #362).
 */
export type TileScratch = {
  texture: GPUTexture;
  /** Bytes it holds, mips included (`textureBytesOf`). */
  bytes: number;
  /** Writes the source's current picture again, mips included: what a live texture keeps. */
  fill(): void;
  /** Builds its mips again from the picture it holds, under its readers' rule now (#42). */
  reduce(): void;
  destroy(): void;
};

export function createTileScratch(
  device: GPUDevice,
  options: {
    map: Texture;
    width: number;
    height: number;
    format: GPUTextureFormat;
    errorCode: string;
    /** The colour census's readers, whose rule each reduction asks; none for a data texture. */
    coverage?: CoverageReaders;
  },
): TileScratch {
  const { width, height, format } = options;
  const descriptor: GPUTextureDescriptor = {
    label: 'Trillion3D texture scratch',
    size: { width, height, depthOrArrayLayers: 1 },
    format,
    mipLevelCount: mipLevelCountFor(width, height),
    usage:
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_DST |
      GPUTextureUsage.COPY_SRC |
      GPUTextureUsage.RENDER_ATTACHMENT,
  };
  const texture = device.createTexture(descriptor);
  /** The texels as uploaded, when they differ from the source's: one array kept for every fill —
   *  a live texture refills at each video frame, and its size never changes. */
  let staged: Uint8Array | undefined;
  /** Sends the picture as it is now and builds its mips again, in the same texture. `flipY` and
   *  `premultiplyAlpha` as the WebGL2 upload (`UNPACK_FLIP_Y_WEBGL`,
   *  `UNPACK_PREMULTIPLY_ALPHA_WEBGL`): the picture's last row lands at v = 0 (#362). */
  const fill = () => {
    const { map } = options;
    const rgba = textureRgba(map);
    if (rgba) {
      const refusal = texelsRefusal(map);
      if (refusal) throw new Error(refusal);
      if (rgba.width !== width || rgba.height !== height) throw new Error('TEXTURE_SOURCE_SIZE');
      const texels =
        map.flipY || map.premultiplyAlpha
          ? uploadedRgba(map, rgba.data, (staged ??= new Uint8Array(width * height * 4)), width)
          : rgba.data;
      writeRgba(device.queue, texture, [0, 0, 0], texels, width, height);
    } else {
      const image = map.image as GPUCopyExternalImageSource | undefined;
      if (!image || typeof device.queue.copyExternalImageToTexture !== 'function')
        throw new Error(options.errorCode);
      device.queue.copyExternalImageToTexture(
        { source: image, flipY: map.flipY },
        { texture, premultipliedAlpha: map.premultiplyAlpha },
        [width, height],
      );
    }
    reduce();
  };
  const reduce = () => {
    const cutoff = options.coverage?.cutoff(options.map);
    generateMaterialMips(device, texture, format, width, height, cutoff !== undefined, cutoff);
  };
  try {
    fill();
  } catch (error) {
    // A picture refused at its first fill leaves no texture behind: its tile asks again.
    texture.destroy();
    throw error;
  }
  return {
    texture,
    bytes: textureBytesOf(descriptor) ?? 0,
    fill,
    reduce,
    destroy: () => texture.destroy(),
  };
}

/** RGBA8 texels as the WebGL2 upload stores them, written into `out`, which it returns: rows in
 *  reverse order under `flipY`, colour times alpha under `premultiplyAlpha` (`premultipliedByte`,
 *  the CPU twin's rule). */
function uploadedRgba(map: Texture, data: Uint8Array, out: Uint8Array, width: number) {
  const row = width * 4,
    height = out.length / row;
  for (let y = 0; y < height; y++) {
    const from = y * row,
      to = (map.flipY ? height - 1 - y : y) * row;
    out.set(data.subarray(from, from + row), to);
    if (map.premultiplyAlpha)
      for (let x = to; x < to + row; x += 4)
        for (let c = 0; c < 3; c++) out[x + c] = premultipliedByte(out[x + c], out[x + 3]);
  }
  return out;
}
