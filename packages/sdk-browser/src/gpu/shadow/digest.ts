/** What a shadow-atlas read publishes: its size, what is written there, its fingerprint. */
export interface ShadowAtlasDigest {
  /** Side of the atlas, in texels. */
  size: number;
  /** Texels in use. */
  texels: number;
  /** Texels whose depth is not the origin zero: what the maps actually occupy. */
  written: number;
  /** 32-bit FNV-1a fingerprint of the raw depths, bit for bit. */
  hash: number;
}

const OFFSET = 0x811c9dc5,
  PRIME = 0x01000193;

/**
 * Reads the depth shadow atlas — `texture`, `size` texels a side, every layer — and returns its
 * fingerprint, bit for bit.
 *
 * This is the proof tool of the page draw: two runs of the same scene, one redrawing whole faces
 * and the other only the invalidated pages, must return **the same fingerprint**. The read only
 * makes sense once the queue is empty — a page still pending obviously carries the old depth.
 *
 * This is not a frame pass: it allocates its buffer, reads, and returns it. None of that happens
 * until the host asks for it.
 */
export async function readShadowAtlasDigest(
  device: GPUDevice,
  texture: GPUTexture,
  size: number,
): Promise<ShadowAtlasDigest> {
  const bytesPerRow = size * 4,
    layers = texture.depthOrArrayLayers;
  const buffer = device.createBuffer({
    label: 'Trillion3D shadow atlas digest',
    size: bytesPerRow * size * layers,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = device.createCommandEncoder({ label: 'Trillion3D shadow atlas digest' });
    encoder.copyTextureToBuffer(
      { texture, aspect: 'depth-only' },
      { buffer, bytesPerRow, rowsPerImage: size },
      [size, size, layers],
    );
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(buffer.getMappedRange());
    // Length is read before `unmap`: that detaches the buffer and would zero it.
    const texels = words.length;
    let hash = OFFSET,
      written = 0;
    for (let index = 0; index < words.length; index++) {
      const word = words[index];
      if (word !== 0) written++;
      for (let byte = 0; byte < 32; byte += 8) {
        hash = Math.imul(hash ^ ((word >>> byte) & 0xff), PRIME);
      }
    }
    buffer.unmap();
    return { size, texels, written, hash: hash >>> 0 };
  } finally {
    buffer.destroy();
  }
}
