import { LIGHT_SETTINGS } from '../../../../sdk-core/src/index.ts';
import { LIGHT_TILES_SHADER } from './shader.ts';
import { createCheckedShaderModule } from '../../gpu/core/shaderModule.ts';
import { createWebgpuBindIdentity } from '../../webgpu/core/bindIdentity.ts';
import { TILE_STRIDE_WORDS } from '../direct/lightWgsl.ts';
/** Label of the measured pass; `gpuLightListsMs` is read under this name, not by its rank. */
export const LIGHT_TILES_PASS = 'Trillion3D light tiles v1';
/** Tiles on one axis: the list always covers the whole target, never one tile short. */
const tilesOn = (pixels: number) => Math.max(1, Math.ceil(pixels / LIGHT_SETTINGS.tileSize));
export type GpuLightTiles = Awaited<ReturnType<typeof createGpuLightTiles>>;

/**
 * Per-tile light-list pass. The tile buffer is allocated for the current target and reallocated
 * only when it changes size; the group follows the light buffer, which grows with the scene;
 * encoding allocates nothing.
 */
export async function createGpuLightTiles(device: GPUDevice) {
  const module = await createCheckedShaderModule(device, LIGHT_TILES_SHADER, 'LIGHT_TILES_SHADER');
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'depth' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const uniform = device.createBuffer({
    label: 'Trillion3D light tile view v1',
    size: 80,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const packed = new Float32Array(20);
  let pipeline: GPUComputePipeline | undefined;
  try {
    pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: 'lightTiles' },
    });
  } catch (error) {
    uniform.destroy();
    throw error;
  }
  let tiles: GPUBuffer | undefined,
    group: GPUBindGroup | undefined,
    tilesX = 0,
    tilesY = 0;
  const bound = createWebgpuBindIdentity();
  return {
    /** Buffer the deferred resolve rereads; never undefined after an `ensure()`. */
    get buffer() {
      return tiles;
    },
    get tilesX() {
      return tilesX;
    },
    get tilesY() {
      return tilesY;
    },
    /** Ensures the target buffer and the bind group; returns `true` if the pass is ready. */
    ensure(width: number, height: number, depth: GPUTextureView, lights: GPUBuffer) {
      const wantedX = tilesOn(width),
        wantedY = tilesOn(height);
      if (!tiles || wantedX !== tilesX || wantedY !== tilesY) {
        tiles?.destroy();
        tilesX = wantedX;
        tilesY = wantedY;
        tiles = device.createBuffer({
          label: 'Trillion3D light tiles v1',
          size: tilesX * tilesY * TILE_STRIDE_WORDS * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        group = undefined;
      }
      bound.next[0] = depth;
      bound.next[1] = lights;
      if (bound.moved() || !group) {
        group = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: depth },
            { binding: 1, resource: { buffer: uniform } },
            { binding: 2, resource: { buffer: lights } },
            { binding: 3, resource: { buffer: tiles } },
          ],
        });
      }
      return !!group;
    },
    update(inverseViewProjection: ArrayLike<number>, width: number, height: number) {
      packed.set(inverseViewProjection as number[], 0);
      packed[16] = width;
      packed[17] = height;
      packed[18] = tilesX;
      packed[19] = tilesY;
      device.queue.writeBuffer(uniform, 0, packed);
    },
    encode(encoder: GPUCommandEncoder) {
      if (!pipeline || !group) return false;
      const pass = encoder.beginComputePass({ label: LIGHT_TILES_PASS });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(tilesX, tilesY, 1);
      pass.end();
      return true;
    },
    dispose() {
      uniform.destroy();
      tiles?.destroy();
      tiles = undefined;
      group = undefined;
    },
  };
}
