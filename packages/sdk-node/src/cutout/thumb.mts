import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SCOPE } from '../../../sdk-core/src/index.ts';
import { previewLevelSize, readPagedManifest } from '../../../sdk-core/src/index.ts';

/**
 * The thumbnails a compile already ships, read back for whoever asks the cutout questions.
 *
 * Every compiled model carries a progressive tail of each colour texture in its manifest sidecar —
 * that is what the engine samples while the real texture streams in. Those same levels answer
 * "what does this texture look like", so nothing new is written, encoded or transported for the
 * asking: the picture on screen is the picture the cache already holds.
 */
export interface Thumbnail {
  sha256: string;
  width: number;
  height: number;
  /** Straight RGBA8, the finest level the sidecar carries (64 px on its longest side at most). */
  rgba: Uint8Array;
  /** The view of the published `source.bin` holding the image's own bytes, when the scene embedded
   *  it rather than linking a file — those bytes are the texture at full resolution. */
  sourceBufferView?: number;
}

/** Where a scope's compiled product lives, or `null` when it points nowhere. */
async function keyDirectory(cache: string, scope: string): Promise<string | null> {
  const pointer: unknown = JSON.parse(
    await readFile(join(cache, 'native', scope, 'manifest.json'), 'utf8'),
  );
  const key = (pointer as { key?: string }).key;
  return key ? join(cache, 'native', scope, key) : null;
}

/** The compiled manifest a scope points at, read from its root through its pages. */
async function manifestOf(cache: string, scope: string) {
  const directory = await keyDirectory(cache, scope);
  if (!directory) return null;
  const root = JSON.parse(await readFile(join(directory, 'clusters.json'), 'utf8')) as object;
  // The previews live in the head page's columns alone: no mesh page is read.
  return readPagedManifest({ ...root, pages: [] }, (page) => readFile(join(directory, page.url)));
}

/**
 * The thumbnails of one compiled model, by image sha256 — the key the answer sheet uses, so a
 * texture shared by two models is looked up once. A model whose cache holds no readable manifest
 * simply contributes none; the question is still asked, with its numbers and without its picture.
 */
export async function readThumbnails(
  cache: string,
  scope: string = DEFAULT_SCOPE,
): Promise<Map<string, Thumbnail>> {
  const thumbnails = new Map<string, Thumbnail>();
  const manifest = await manifestOf(cache, scope).catch(() => null);
  if (!manifest) return thumbnails;
  for (const preview of manifest.texturePreviews ?? []) {
    const [width, height] = previewLevelSize(preview.width, preview.height, preview.firstLevel);
    const rgba = preview.levels[0];
    if (!rgba || rgba.length < width * height * 4) continue;
    thumbnails.set(preview.sha256, {
      sha256: preview.sha256,
      width,
      height,
      // Copied rather than kept as a view: a retained level would otherwise pin the whole sidecar,
      // megabytes, for the few kilobytes we show.
      rgba: Uint8Array.from(rgba),
      // The public contract says so: a `uri` source carries -1, so any non-negative index is an
      // embedded image. No internal constant to borrow for that.
      sourceBufferView: preview.sourceBufferView >= 0 ? preview.sourceBufferView : undefined,
    });
  }
  return thumbnails;
}

/** The alpha of a thumbnail as an opaque grey picture: white is what shows, black what disappears. */
export function alphaOf(thumbnail: Thumbnail): Thumbnail {
  const rgba = new Uint8Array(thumbnail.width * thumbnail.height * 4);
  for (let at = 0; at < rgba.length; at += 4) {
    const alpha = thumbnail.rgba[at + 3] ?? 0;
    rgba[at] = rgba[at + 1] = rgba[at + 2] = alpha;
    rgba[at + 3] = 255;
  }
  return { ...thumbnail, rgba };
}

/** Nearest-neighbour resize, for a terminal that measures its pictures in character cells. */
export function resize(thumbnail: Thumbnail, width: number, height: number): Thumbnail {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const source = Math.min(thumbnail.height - 1, Math.floor((y * thumbnail.height) / height));
    for (let x = 0; x < width; x++) {
      const column = Math.min(thumbnail.width - 1, Math.floor((x * thumbnail.width) / width));
      const from = (source * thumbnail.width + column) * 4;
      const to = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        rgba[to + channel] = thumbnail.rgba[from + channel] ?? 0;
    }
  }
  return { sha256: thumbnail.sha256, width, height, rgba };
}

/**
 * Reads the embedded images of one compiled model: the scene's own bytes, at full resolution, from
 * the `source.bin` the compile published beside its manifest. A model that links its textures as
 * files has none, and needs none — the file itself is sharper than anything we could rebuild.
 */
/**
 * Embedded images of the models in a pass, by cache: opened at the first question that asks for
 * them and not before, and released with the pass — a `source.bin` weighs tens of megabytes, a
 * long-lived host must not keep them from one batch to the next.
 */
export type EmbeddedImages = Map<string, Promise<(view: number) => Buffer | null>>;
export async function embeddedImages(
  cache: string,
  scope: string = DEFAULT_SCOPE,
): Promise<(view: number) => Buffer | null> {
  const directory = await keyDirectory(cache, scope).catch(() => null);
  if (!directory) return () => null;
  const [scene, bytes] = await Promise.all([
    readFile(join(directory, 'source.gltf'), 'utf8').then(
      (text) =>
        JSON.parse(text) as { bufferViews?: { byteOffset?: number; byteLength?: number }[] },
      () => null,
    ),
    readFile(join(directory, 'source.bin')).catch(() => null),
  ]);
  if (!scene?.bufferViews || !bytes) return () => null;
  return (view: number) => {
    const descriptor = scene.bufferViews?.[view];
    if (!descriptor?.byteLength) return null;
    const from = descriptor.byteOffset ?? 0;
    return bytes.subarray(from, from + descriptor.byteLength);
  };
}
