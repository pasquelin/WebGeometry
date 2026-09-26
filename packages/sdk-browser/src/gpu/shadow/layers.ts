/** How the shading binds a shadow depth texture: every layer of the pool, one array. */
export const SHADOW_ARRAY: GPUTextureBindingLayout = {
  sampleType: 'depth',
  viewDimension: '2d-array',
};

/** The shadow texture `texture` as the shading samples it: every layer of the pool, one array. */
export const arrayView = (texture: GPUTexture) => texture.createView({ dimension: '2d-array' });

/** One 2D view per layer of a shadow texture: what a pass draws a page into, or reads it from. */
export const layerViews = (texture: GPUTexture) =>
  Array.from({ length: texture.depthOrArrayLayers }, (_, layer) =>
    texture.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
  );

/** The render pass of each layer, over its depth `depths[l]` and colour `colours?.[l]`: made once. */
export const layerPasses = (label: string, depths: GPUTextureView[], colours?: GPUTextureView[]) =>
  depths.map((view, layer): GPURenderPassDescriptor => ({
    label,
    colorAttachments: colours ? [{ view: colours[layer], loadOp: 'load', storeOp: 'store' }] : [],
    depthStencilAttachment: { view, depthLoadOp: 'load', depthStoreOp: 'store' },
  }));

/** Ends the pass open before, if any, and begins `descriptor`'s: at a layer's first drawn page. */
export function layerPass(
  encoder: GPUCommandEncoder,
  before: GPURenderPassEncoder | undefined,
  descriptor: GPURenderPassDescriptor,
) {
  before?.end();
  return encoder.beginRenderPass(descriptor);
}
