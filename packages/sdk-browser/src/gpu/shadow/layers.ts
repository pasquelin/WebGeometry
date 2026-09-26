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

/** Ends the pass of the layer before `at`, if any, and begins layer `at`'s on its targets. */
export function layerPass(
  encoder: GPUCommandEncoder,
  label: string,
  at: number,
  before: GPURenderPassEncoder,
  depth: GPUTextureView,
  colour?: GPUTextureView,
) {
  if (at) before.end();
  return encoder.beginRenderPass({
    label,
    colorAttachments: colour ? [{ view: colour, loadOp: 'load', storeOp: 'store' }] : [],
    depthStencilAttachment: { view: depth, depthLoadOp: 'load', depthStoreOp: 'store' },
  });
}
