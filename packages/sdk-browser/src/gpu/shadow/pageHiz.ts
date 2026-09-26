import { hizLevelSizes } from '../hiz/oracle.ts';
import { createHizPipelines } from '../hiz/pipelines.ts';
import { writeHizLevelUniforms } from '../hiz/uniforms.ts';
import { SHADOW_PAGE } from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { MAX_SHADOW_PAGES } from './recordPack.ts';
import { shadowBatchWrites } from './batchWrites.ts';
import { PAGE_BOUNDS_WORDS } from './batchBudget.ts';

const UNIFORM_BYTES = 256;
/** Levels of a page's pyramid, from the page's 128 texels down to one. */
export const PAGE_HIZ_LEVELS = Math.log2(SHADOW_PAGE) + 1;
/** First word of each level inside one page's pyramid, and the words of a whole pyramid. */
export const PAGE_HIZ_OFFSETS = Array.from({ length: PAGE_HIZ_LEVELS }, (_, level) => {
  let offset = 0;
  for (let l = 0; l < level; l++) offset += (SHADOW_PAGE >> l) ** 2;
  return offset;
});
export const PAGE_HIZ_WORDS = PAGE_HIZ_OFFSETS[PAGE_HIZ_LEVELS - 1] + 1;

/**
 * THE DEPTH PYRAMIDS OF THE STATIC LAYER'S PAGES, built by the camera's own Hi-Z kernels
 * (`../hiz/shader.ts`): one pyramid per page a moving caster is drawn over, from the page's
 * 128 × 128 texels of the static layer down to one, each level the farthest of four. The copy
 * and the reduction run once for all the frame's pages, a page per `z`.
 *
 * The static layer holds the page's static casters, current — a page restored from it this frame
 * was drawn there in full earlier or now — so its pyramid is not a previous frame's guess: a
 * moving caster behind it from the light writes nothing, and culling it changes no texel.
 */
export async function createShadowPageHiz(device: GPUDevice, layer: GPUTextureView) {
  const pipelines = await createHizPipelines(device, UNIFORM_BYTES);
  if (!pipelines) throw new Error('SHADOW_PAGE_HIZ_UNAVAILABLE');
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const pyramid = device.createBuffer({
      label: 'Trillion3D shadow page pyramids v1',
      size: MAX_SHADOW_PAGES * PAGE_HIZ_WORDS * 4,
      usage: GPUBufferUsage.STORAGE,
    }),
    origins = device.createBuffer({
      size: MAX_SHADOW_PAGES * PAGE_BOUNDS_WORDS * 4,
      usage: storage,
    }),
    // The layout's verdict and state bindings: the page pyramids write neither, and two writable
    // bindings may not share a buffer.
    idleFlags = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE }),
    idleState = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE }),
    uniforms = device.createBuffer({
      size: PAGE_HIZ_LEVELS * UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  // Slot 0 copies the page's level 0; slot `l` reduces level `l − 1` into level `l`.
  writeHizLevelUniforms(
    device,
    uniforms,
    new Uint32Array((PAGE_HIZ_LEVELS * UNIFORM_BYTES) / 4),
    hizLevelSizes(SHADOW_PAGE, SHADOW_PAGE),
    PAGE_HIZ_OFFSETS,
    SHADOW_PAGE,
    SHADOW_PAGE,
    PAGE_HIZ_LEVELS,
    UNIFORM_BYTES,
    PAGE_HIZ_WORDS,
  );
  const group = device.createBindGroup({
    layout: pipelines.layout,
    entries: [
      { binding: 0, resource: { buffer: pyramid } },
      { binding: 1, resource: layer },
      { binding: 2, resource: { buffer: uniforms, size: UNIFORM_BYTES } },
      { binding: 3, resource: { buffer: origins } },
      { binding: 4, resource: { buffer: idleFlags } },
      { binding: 5, resource: { buffer: idleState } },
    ],
  });
  const originWords = new Int32Array(MAX_SHADOW_PAGES * PAGE_BOUNDS_WORDS);
  return {
    pyramid,
    /** Builds the pyramids of `count` pages, whose level-0 texel origins `origin(i)` gives. */
    encode(
      encoder: GPUCommandEncoder,
      count: number,
      origin: (page: number, out: Int32Array, at: number) => void,
    ) {
      if (!count) return;
      for (let page = 0; page < count; page++) origin(page, originWords, page * PAGE_BOUNDS_WORDS);
      shadowBatchWrites(device).write(origins, 0, originWords, 0, count * PAGE_BOUNDS_WORDS);
      const pass = encoder.beginComputePass({ label: 'Trillion3D shadow page pyramids' });
      pass.setBindGroup(0, group, [0]);
      pass.setPipeline(pipelines.copyPipeline);
      pass.dispatchWorkgroups(SHADOW_PAGE / 8, SHADOW_PAGE / 8, count);
      pass.setPipeline(pipelines.reducePipeline);
      for (let level = 1; level < PAGE_HIZ_LEVELS; level++) {
        pass.setBindGroup(0, group, [level * UNIFORM_BYTES]);
        const groups = Math.max(1, Math.ceil((SHADOW_PAGE >> level) / 8));
        pass.dispatchWorkgroups(groups, groups, count);
      }
      pass.end();
    },
    dispose() {
      for (const buffer of [pyramid, origins, idleFlags, idleState, uniforms]) buffer.destroy();
    },
  };
}

export type ShadowPageHiz = Awaited<ReturnType<typeof createShadowPageHiz>>;
