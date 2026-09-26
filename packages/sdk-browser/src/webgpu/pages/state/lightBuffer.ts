import {
  SCENE_ENVIRONMENT_FLOATS,
  SCENE_LIGHT_FLOATS,
  SCENE_LIGHT_HEADER_FLOATS,
  type SceneLightStore,
} from '../../../../../sdk-core/src/index.ts';
import { LTC_SIZE, ltcTable } from '../../../../../sdk-core/src/lighting/ltcTable.ts';
import type { WebgpuLightState } from './lights.ts';

/** Bytes before the light slots (`DirectLights`): the header, the environment's irradiance, then
 *  the fitted lobe of the rectangles, two `vec4f` per cell. */
const HEAD_BYTES = SCENE_LIGHT_HEADER_FLOATS * 4,
  LTC_BYTES = HEAD_BYTES + SCENE_ENVIRONMENT_FLOATS * 4,
  ITEMS_BYTES = LTC_BYTES + LTC_SIZE * LTC_SIZE * 32;
const SLOT_BYTES = SCENE_LIGHT_FLOATS * 4;

/** Contract light buffer for the store's light slots — the header, the environment's irradiance,
 *  the fitted lobe of the rectangles, written here once, then every slot. */
export function createSceneLightContractBuffer(device: GPUDevice, store: SceneLightStore) {
  const buffer = device.createBuffer({
    label: 'Trillion3D direct lights v1',
    size: ITEMS_BYTES + store.capacity * SLOT_BYTES,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(buffer, LTC_BYTES, ltcTable());
  return buffer;
}

/** Light slots `buffer` holds. */
const contractBufferSlots = (buffer: GPUBuffer) => (buffer.size - ITEMS_BYTES) / SLOT_BYTES;

/**
 * Pushes the store to the GPU if and only if its revision has changed since the last image. A
 * store grown past the buffer's slots gets a new buffer first, the old one released: its holders
 * — the tile pass, the resolve, the blend and water passes, bounce — compare the buffer they
 * bound with `lights.buffer` and bind the new one.
 */
export function uploadSceneLights(device: GPUDevice, lights: WebgpuLightState) {
  const { store } = lights;
  if (!lights.buffer) return false;
  if (contractBufferSlots(lights.buffer) !== store.capacity) {
    lights.buffer.destroy();
    lights.buffer = createSceneLightContractBuffer(device, store);
    lights.uploadedEpoch = -1;
  }
  if (lights.uploadedEpoch === store.epoch) return false;
  lights.uploadedEpoch = store.epoch;
  const { buffer } = lights,
    { packed } = store;
  device.queue.writeBuffer(buffer, 0, packed, 0, SCENE_LIGHT_HEADER_FLOATS);
  device.queue.writeBuffer(buffer, HEAD_BYTES, store.environmentPacked);
  // Only the declared slots: those past the count are never read.
  device.queue.writeBuffer(
    buffer,
    ITEMS_BYTES,
    packed,
    SCENE_LIGHT_HEADER_FLOATS,
    store.count * SCENE_LIGHT_FLOATS,
  );
  return true;
}
