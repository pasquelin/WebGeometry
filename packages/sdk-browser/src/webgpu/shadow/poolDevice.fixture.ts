// The device the shadow pool tests size against: 8 192 texels wide, and refusing, as out of
// memory, every texture past `limit` bytes.
import { asWebgpuDevice } from '../../../../../tests/kit/gpu/webgpuDevice.ts';

export function refusingDevice(limit: number, members: Record<string, unknown> = {}) {
  const gpu = asWebgpuDevice({
    ...members,
    createBuffer: () => ({ destroy() {} }),
    limits: { maxTextureDimension2D: 8192 },
    createTexture: ({ size }: { size: number[] }) => {
      if (size[0] * size[1] * 4 > limit) gpu.raise('Out of memory');
      return { destroy() {}, createView: () => ({}) };
    },
  });
  return gpu;
}
