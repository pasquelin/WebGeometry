/** The measure of #44: each coverage chain of a compiled cache, its share of texels at or above
 *  its cutoff byte at every level against level 0's, one JSON line per chain, from the texels the
 *  engine samples: the head's lossless files and the sidecar's tail, or blocks the gate kept.
 *  `node scripts/texture-coverage-levels.ts <cache directory> [scope, full by default]` */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCacheManifest } from '../bench/runner/cacheManifest.ts';
import {
  PREVIEW_LOSSLESS_FORMAT,
  previewIsWhole,
  previewLevelSize,
  textureLevelUrl,
  type ClusterManifest,
} from '../packages/sdk-core/src/index.ts';
import { previewCoverageCutoff } from '../packages/sdk-core/src/texture/previewFormat.ts';
import { decodePng } from '../packages/sdk-node/src/cutout/png.mts';

/** Where a chain that names no cutoff — develop's word 2, before #44 — is counted: glTF's default
 *  `alphaCutoff` of 0.5, so both sides of a comparison count the same texels. */
const UNCUT_BYTE = 128;

/** Every whole coverage chain of a manifest, `readHead` giving a head level's lossless file from
 *  its address relative to the manifest. */
export async function coverageLevels(
  manifest: ClusterManifest,
  readHead: (url: string) => Promise<Uint8Array>,
) {
  const template = manifest.textures?.url;
  const chains = [];
  for (const preview of manifest.texturePreviews ?? []) {
    const { texture, sha256, atlas } = preview;
    const named = previewCoverageCutoff(atlas);
    if (named === undefined || !template || !previewIsWhole(preview)) continue;
    const cutoff = named || UNCUT_BYTE;
    const count = (rgba: Uint8Array) => {
      let covered = 0;
      for (let at = 3; at < rgba.length; at += 4) if ((rgba[at] ?? 0) >= cutoff) covered++;
      return [covered, rgba.length / 4] as const;
    };
    const head = await Promise.all(
      Array.from({ length: preview.firstLevel }, async (_, level) => {
        const url = textureLevelUrl(template, sha256, atlas, level, PREVIEW_LOSSLESS_FORMAT);
        return count(decodePng(await readHead(url)).rgba);
      }),
    );
    const counts = [...head, ...preview.levels.map(count)];
    const [covered0 = 0, texels0 = 1] = counts[0] ?? [];
    const levels = counts.map(([covered, texels], level) => ({
      level,
      size: previewLevelSize(preview.width, preview.height, level),
      covered,
      relative: covered0 ? (covered * texels0) / (texels * covered0) - 1 : Math.sign(covered),
    }));
    chains.push({ texture, sha256, cutoff, levels });
  }
  return chains;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cache = '', scope = 'full'] = process.argv.slice(2);
  const { dir, manifest } = await readCacheManifest(join(cache, 'native', scope));
  const read = (url: string) => readFile(join(dir, url));
  for (const chain of await coverageLevels(manifest, read)) console.log(JSON.stringify(chain));
}
