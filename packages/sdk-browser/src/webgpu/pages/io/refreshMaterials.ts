import { followHostTexture } from '../../../host/textureImport.ts';
import { pictureFits } from '../../tile/live.ts';
import type { WebgpuPagesRuntime } from '../runtime.ts';
import { refreshBlendMaterials } from '../../blend/resources.ts';

/**
 * Host surfaces rewritten in place (#335). When their values moved, every row is written again at
 * the next frame, and the writer rereads each surface whose version moved
 * (`row/pageRowConstants.ts`); only values and pictures changed, so no resolve class did. When
 * only their textures moved (`values` false) — a video's frame, a canvas redrawn, a sampling —, no
 * row reads them: the render follows the headers and copies a moved picture into the pool itself
 * (`../render/render.ts`, `../../tile/live.ts`, #362), which releases a held image, and the row
 * table is left as it is. A picture whose size changed cannot be copied: its tiles were laid out
 * at the old one, and false asks the owner for a new session.
 */
export function refreshWebgpuMaterials(rt: WebgpuPagesRuntime, values = true) {
  if (values) {
    rt.layout.rows.tableEpoch++;
    rt.run.gate.sceneMoved();
    // A transparent item copied its colour at prepare: it is taken again, its record rewritten.
    if (rt.gpu.device) refreshBlendMaterials(rt, rt.gpu.device);
  }
  const textures = rt.vis.textures;
  if (!textures) return true;
  return [textures.color, textures.data].every((atlas) =>
    atlas.textures.every((entry) => {
      if (entry.source.kind === 'host') followHostTexture(entry.source.map);
      return pictureFits(entry);
    }),
  );
}
