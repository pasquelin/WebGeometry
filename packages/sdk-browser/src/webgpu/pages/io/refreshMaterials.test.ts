// A blended item copies its colour and opacity at prepare. A surface the host rewrites in place
// (`setMaterial`, #267) must reach its item record at the values refresh, not only at a move.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../../../host/graph/graph.fixture.ts';
import { webgpuPagesBackend } from '../pages.ts';
import { installGpuGlobals } from '../../../../../../tests/kit/gpu/globals.ts';
import { mockGpu } from '../../../../../../tests/kit/gpu/mockGpu.ts';
import { quadScene, camera } from '../testScenes.fixture.ts';

test('a blended surface rewritten in place reaches its item record at the values refresh', async () => {
  installGpuGlobals();
  const fixture = quadScene(),
    { device, writes } = mockGpu();
  fixture.metadata.primitives[0].pass = 'shared-blend';
  fixture.material.transparent = true;
  fixture.material.opacity = 0.5;
  const backend = webgpuPagesBackend({
    ...fixture,
    gpuDevice: device,
    maxResidentPages: 2,
    viewport: [32, 32],
  });
  const rgba = () => {
    const last = writes.filter((w) => w.label === 'Trillion3D blend item records').at(-1)!;
    return [...new Float32Array(last.bytes.slice().buffer).subarray(16, 20)];
  };
  try {
    await backend.prepare();
    backend.render(camera());
    assert.deepEqual(rgba(), [1, 0, 0, 0.5]);
    (fixture.material.color as G.Color).setRGB(0, 0.5, 1);
    fixture.material.opacity = 0.25;
    fixture.material.needsUpdate = true;
    backend.refreshMaterials?.(true);
    backend.render(camera());
    assert.deepEqual(rgba(), [0, 0.5, 1, 0.25]);
  } finally {
    backend.dispose();
    fixture.geometry.dispose();
    fixture.material.dispose();
  }
});
