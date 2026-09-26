import { DRAW_INDIRECT_STRIDE } from '../../../gpu/draw/draw.ts';
import { MAX_SHADOW_REGIONS } from '../../../gpu/shadow/atlas.ts';
import { layerPass } from '../../../gpu/shadow/layers.ts';
import { HIZ_UNTESTED } from '../../../gpu/shadow/occlusion.ts';
import { REGION_RESTORE, REGION_STATIC } from '../../shadow/regions.ts';
import { shadowRegionGroup } from '../../shadow/regionGroups.ts';
import { MAX_LAYERS, SHADOW_PAGE } from '../../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import type { WebgpuPagesRuntime } from '../runtime.ts';
import { encodeShadowCasters } from '../../shadow/casters.ts';
import type { ShadowTransmittance } from '../../../gpu/shadow/transmittance.ts';

/** Pyramid slot of each region this frame, `HIZ_UNTESTED` for a region drawn as culled, and the
 *  region each slot was given to. */
const slotOf = new Uint32Array(MAX_SHADOW_REGIONS),
  regionOf = new Uint32Array(MAX_SHADOW_REGIONS),
  /** Where each layer's slots end: slots are numbered layer by layer (`pageHiz.ts`). */
  ends = new Uint32Array(MAX_LAYERS);

/**
 * The pages a moving caster is drawn over get a pyramid of their static layer, and each restored
 * region keeps only the moving casters it does not hide from the light
 * (`../../../gpu/shadow/occlusion.ts`). A frame without a restored region, or before the pyramids
 * exist, tests nothing. Returns whether the restored regions draw from the visible lists.
 */
function encodeOcclusion(rt: WebgpuPagesRuntime, encoder: GPUCommandEncoder, count: number) {
  const { lights, run, layout, setup } = rt,
    { regions, pageHiz, occlusion, cull, spheres, shadows } = lights;
  if (!pageHiz || !occlusion || !cull || !spheres || !shadows) return false;
  let pages = 0;
  for (let layer = 0; layer < shadows.targets.length; layer++) {
    for (let region = 0; region < count; region++) {
      if (regions.layer(region) !== layer) continue;
      const restored = regions.startOf(region) === REGION_RESTORE;
      if (restored) regionOf[pages] = region;
      slotOf[region] = restored ? pages++ : HIZ_UNTESTED;
    }
    ends[layer] = pages;
  }
  if (!pages) return false;
  pageHiz.encode(encoder, ends.subarray(0, shadows.targets.length), (slot, out, at) => {
    const region = regionOf[slot];
    out[at] = regions.x(region);
    out[at + 1] = regions.y(region);
  });
  const inputs = {
    spheres: spheres.buffer,
    kept: cull.kept,
    indirect: cull.indirect,
    views: shadows.faceUniform,
    pyramid: pageHiz.pyramid,
  };
  // A list holds the visibility rows and the blended casters' rows in use, at most.
  const rows = layout.rows.packedCount + rt.services.blendCasters.used;
  occlusion.encode(encoder, inputs, count, (r) => slotOf[r], rows, setup.maxCorners, run.frame);
  return true;
}

/**
 * Shadow depth pass of one batch, pages `[from, to)` of the frame's list in `count` regions: first
 * their face uniforms, then the casters of each light view drawn, selected from the light and
 * culled per region (`encodeShadowCasters`); then the static layer's pages drawn in full, if any;
 * then the moving casters of each restored page tested against its static layer; then a render
 * pass per layer of the pool, where each region of that layer starts from its page cleared to far or restored from the
 * static layer, and draws its casters.
 *
 * **The viewport is the physical page, the matrix the virtual page's own projection.** The page
 * fills the clip square, so the rasterizer clips every caster at its edge and no other page of the
 * pool is touched; the scissor says the same square once more.
 *
 * Once a blended caster has held a row, the pass of the transmittance layer follows
 * (`encodeTransmittance`). Before, the shadow passes are the ones they were.
 */
export function encodeShadowAtlas(
  rt: WebgpuPagesRuntime,
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  count: number,
  from: number,
  to: number,
  runBase: number,
) {
  const { lights, vis, run } = rt,
    { shadows, cull, regions, staticLayer, occlusion } = lights;
  if (!count || !shadows?.texture || !cull || !vis.visBindGroupLayout) return false;
  if (regions.layered && !staticLayer) return false;
  if (!shadowRegionGroup(rt, device, 0)) return false;
  shadows.flushPages(count);
  if (!encodeShadowCasters(rt, encoder, count, from, to, runBase)) return false;
  cull.counts.sample(encoder, cull.indirect, count, run.frame);
  lights.shadowDraws += count;
  const drawsBefore = run.gpuDrawCalls;
  const draw = (passes: GPURenderPassDescriptor[], layer: boolean, tested: boolean) => {
    let pass!: GPURenderPassEncoder,
      open = -1;
    for (let i = 0; i < count * passes.length; i++) {
      const region = i % count,
        at = (i - region) / count;
      const start = regions.startOf(region);
      if (layer !== (start === REGION_STATIC) || regions.layer(region) !== at) continue;
      const visible = tested && start === REGION_RESTORE;
      const group = shadowRegionGroup(rt, device, region, visible);
      if (!group) continue;
      if (open !== at) pass = layerPass(encoder, pass, passes[(open = at)]);
      const x = regions.x(region),
        y = regions.y(region);
      pass.setViewport(x, y, SHADOW_PAGE, SHADOW_PAGE, 0, 1);
      pass.setScissorRect(x, y, SHADOW_PAGE, SHADOW_PAGE);
      if (start === REGION_RESTORE) {
        pass.setPipeline(staticLayer!.restore);
        pass.setBindGroup(0, staticLayer!.groups[at]);
      } else {
        pass.setPipeline(shadows.clear);
        pass.setBindGroup(0, group);
        pass.setBindGroup(1, shadows.faceGroup, [region * shadows.faceStride]);
      }
      pass.draw(3);
      pass.setPipeline(shadows.depth);
      pass.setBindGroup(0, group);
      pass.setBindGroup(1, shadows.faceGroup, [region * shadows.faceStride]);
      const commands = visible ? occlusion!.visibleIndirect : cull.indirect;
      pass.drawIndirect(commands, region * DRAW_INDIRECT_STRIDE);
      run.gpuDrawCalls += 2;
    }
    if (open >= 0) pass.end();
  };
  if (regions.layered) draw(staticLayer!.passes, true, false);
  const tested = encodeOcclusion(rt, encoder, count);
  draw(shadows.passes, false, tested);
  const casters = rt.services.blendCasters.used > 0;
  const transmittance = casters ? shadows.ensureTransmittance(encoder) : shadows.transmittance;
  if (transmittance) encodeTransmittance(rt, device, encoder, count, transmittance, tested);
  lights.shadowDrawCalls += run.gpuDrawCalls - drawsBefore;
  return true;
}

/**
 * The pass of the transmittance layer (`../../../gpu/shadow/transmittance.ts`), at half the pool's
 * resolution: every page the pool's pass drew — cleared or restored — starts from all the light
 * and no translucent depth (the static layer keeps no blended caster: their rows count as moving),
 * then draws its list twice, where only the blended casters' corners survive: depth only, for the
 * nearest translucent depth, then colour only, multiplied into the transmittance. Both test the
 * pool's opaque depth, just drawn. Once the last blended caster has given its row back, the layer
 * stays but the list holds none of them: each page is cleared, which is all the read needs, and
 * neither draw is encoded.
 */
export function encodeTransmittance(
  rt: WebgpuPagesRuntime,
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  count: number,
  layer: ShadowTransmittance,
  tested: boolean,
) {
  const { lights, run } = rt,
    { shadows, cull, regions, occlusion } = lights;
  const casters = rt.services.blendCasters.used > 0;
  const half = SHADOW_PAGE / 2,
    { passes } = layer;
  let pass!: GPURenderPassEncoder,
    open = -1;
  for (let i = 0; i < count * passes.length; i++) {
    const region = i % count,
      at = (i - region) / count;
    const start = regions.startOf(region);
    if (start === REGION_STATIC || regions.layer(region) !== at) continue;
    const visible = tested && start === REGION_RESTORE;
    const group = shadowRegionGroup(rt, device, region, visible);
    if (!group) continue;
    if (open !== at) {
      pass = layerPass(encoder, pass, passes[(open = at)]);
      pass.setBindGroup(2, layer.opaqueGroups[at]);
    }
    const x = regions.x(region) / 2,
      y = regions.y(region) / 2;
    pass.setViewport(x, y, half, half, 0, 1);
    pass.setScissorRect(x, y, half, half);
    pass.setBindGroup(0, group);
    pass.setBindGroup(1, shadows!.faceGroup, [region * shadows!.faceStride]);
    pass.setPipeline(layer.clear);
    pass.draw(3);
    run.gpuDrawCalls++;
    if (!casters) continue;
    const commands = visible ? occlusion!.visibleIndirect : cull!.indirect;
    for (const pipeline of [layer.depth, layer.blend]) {
      pass.setPipeline(pipeline);
      pass.drawIndirect(commands, region * DRAW_INDIRECT_STRIDE);
    }
    run.gpuDrawCalls += 2;
  }
  if (open >= 0) pass.end();
}
