/**
 * How far a cache's decoded geometry pages sit from the source attributes the witnesses read.
 *
 * The autonomous WebGL2 path draws what `decodeGeometryPage` hands back — positions on the
 * primitive's quantization grid, normals as octahedral bytes (`docs/FORMAT.md`) — where every
 * other path reads the float attributes of `source.bin`. Same renderer, same materials, same
 * lights: this file measures the one input that is not the same, corner by corner, so that an
 * image difference between the two can be attributed instead of guessed.
 *
 *     node bench/runner/pageQuantization.ts <cache>/native/full
 *
 * Prints JSON: pages read, corners compared, largest and mean position gap in scene units, and
 * largest and mean angle between the decoded normal and the source one.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCacheManifest } from './cacheManifest.ts';
import { decodeGeometryPage } from '../../packages/sdk-browser/src/page/decode/geometryPage.ts';

const ITEMS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Float accessors of the source glTF, read out of `source.bin` and held by accessor index. */
function accessorReader(dir: string) {
  const gltf = JSON.parse(readFileSync(join(dir, 'source.gltf'), 'utf8'));
  const bin = readFileSync(join(dir, 'source.bin'));
  const held = new Map<number, Float32Array>();
  return {
    gltf,
    read(index: number) {
      let floats = held.get(index);
      if (floats) return floats;
      const accessor = gltf.accessors[index],
        view = gltf.bufferViews[accessor.bufferView];
      const start = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const count = accessor.count * ITEMS[accessor.type as string];
      floats = new Float32Array(bin.buffer.slice(start, start + count * 4));
      held.set(index, floats);
      return floats;
    },
  };
}

/** Largest angle, in degrees, between two unit normals read off their own arrays. */
function normalAngle(a: Float32Array, at: number, b: Float32Array, bt: number) {
  let dot = 0;
  for (let axis = 0; axis < 3; axis += 1) dot += a[at + axis] * b[bt + axis];
  return (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
}

async function measureCache(full: string) {
  const { dir, manifest } = await readCacheManifest(full);
  const { gltf, read } = accessorReader(dir);
  // A page URL is relative to the manifest's own directory; nothing else knows the layout.
  const file = (url: string) => new Uint8Array(readFileSync(join(dir, url)));
  let pages = 0,
    corners = 0,
    maxPosition = 0,
    sumPosition = 0,
    maxAngle = 0,
    sumAngle = 0;
  for (const primitive of manifest.primitives) {
    const attributes = gltf.meshes[primitive.mesh].primitives[primitive.primitive].attributes;
    const position = read(attributes.POSITION);
    const normal = attributes.NORMAL === undefined ? undefined : read(attributes.NORMAL);
    for (const page of primitive.pages) {
      if (!page.geometry) continue;
      pages += 1;
      // The index page holds the source vertex of each corner, in the order the geometry page
      // renumbered them: corner `i` of one is corner `i` of the other.
      const packed = file(page.url);
      const indices = new Uint32Array(packed.buffer, packed.byteOffset, packed.byteLength / 4);
      const decoded = decodeGeometryPage(file(page.geometry.url));
      for (let i = 0; i < indices.length; i += 1) {
        const source = indices[i] * 3,
          vertex = decoded.indices[i] * 3;
        let gap = 0;
        for (let axis = 0; axis < 3; axis += 1)
          gap = Math.max(
            gap,
            Math.abs(decoded.attributes.position[vertex + axis] - position[source + axis]),
          );
        maxPosition = Math.max(maxPosition, gap);
        sumPosition += gap;
        if (normal && decoded.attributes.normal) {
          const angle = normalAngle(decoded.attributes.normal, vertex, normal, source);
          maxAngle = Math.max(maxAngle, angle);
          sumAngle += angle;
        }
        corners += 1;
      }
    }
  }
  return {
    cache: full,
    pages,
    corners,
    maxPositionGap: maxPosition,
    meanPositionGap: sumPosition / corners,
    maxNormalGapDegrees: maxAngle,
    meanNormalGapDegrees: sumAngle / corners,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const full = process.argv[2];
  if (!full) throw new Error('usage: pageQuantization.ts <cache>/native/full');
  console.log(JSON.stringify(await measureCache(full), null, 2));
}
