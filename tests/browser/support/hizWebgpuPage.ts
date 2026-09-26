// Page-side kernel of the Hi-Z GPU proof: one `testHiz` dispatch per case, on the real device.
// Serialized into the page by Playwright's `page.evaluate` (`../renders/hiz-webgpu.browser.ts`); it only
// sees its argument, never the module scope.
import type { hizBindEntries } from '../../../packages/sdk-browser/src/gpu/hiz/hiz.ts';

export interface HizCaseSample {
  name: string;
  expected: number;
  // `hizCases.ts` only sets it on the one case that needs it; absent elsewhere means false.
  clipsNear?: boolean;
  size: number;
  data: number[];
}

export interface HizArgs {
  shader: string;
  cases: HizCaseSample[];
  bindEntries: ReturnType<typeof hizBindEntries>;
  /** Group 1 of `testHiz` (`HIZ_TEST_PAGES_ENTRIES`): the page table it reads each row's Hi-Z
   *  slot from. */
  pagesEntries: GPUBindGroupLayoutEntry[];
  /** Bytes of that table: one zeroed row, slot 0, a row the pyramid judges (`PAGE_INFO_STRIDE`). */
  pageInfoBytes: number;
  stateWords: number;
  stTested: number;
  testedU32: number;
  boxNearest: number;
}

export async function executerHiz({
  shader,
  cases,
  bindEntries,
  pagesEntries,
  pageInfoBytes,
  stateWords,
  stTested,
  testedU32,
  boxNearest,
}: HizArgs) {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) return { unavailable: 'No WebGPU adapter' };
  const adapterInfo = {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    device: adapter.info.device,
    description: adapter.info.description,
  };
  // Serialized into the page, this function reaches no module: the device opening `drawRun.ts`
  // shares is written again here, on purpose.
  // jscpd:ignore-start
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.addEventListener('uncapturederror', (event) => {
    const gpuEvent = event as GPUUncapturedErrorEvent;
    errors.push(gpuEvent.error.message);
  });
  const module = device.createShaderModule({ code: shader });
  const info = await module.getCompilationInfo();
  // jscpd:ignore-end
  const compilationErrors = info.messages
    .filter((message) => message.type === 'error')
    .map((message) => message.message);
  if (compilationErrors.length) return { adapter: adapterInfo, compilationErrors, errors };
  const layout = device.createBindGroupLayout({ entries: bindEntries }),
    pagesLayout = device.createBindGroupLayout({ entries: pagesEntries });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout, pagesLayout] }),
    compute: { module, entryPoint: 'testHiz' },
  });
  const texture = device.createTexture({
    size: { width: 1, height: 1 },
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const uniform = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bounds = device.createBuffer({
    size: testedU32 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const flags = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const state = device.createBuffer({
    size: stateWords * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const pages = device.createBuffer({ size: pageInfoBytes, usage: GPUBufferUsage.STORAGE });
  const pagesGroup = device.createBindGroup({
    layout: pagesLayout,
    entries: [{ binding: 0, resource: { buffer: pages } }],
  });
  const readback = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const uni = new Uint32Array(64);
  uni[2] = 1;
  device.queue.writeBuffer(uniform, 0, uni);
  const descriptor = new ArrayBuffer(testedU32 * 4),
    i32 = new Int32Array(descriptor),
    f32 = new Float32Array(descriptor),
    u32 = new Uint32Array(descriptor);
  i32.set([0, 0, 8, 4]);
  f32[4] = boxNearest;
  u32[6] = 797;
  u32[7] = 9;
  const results = [];
  for (const sample of cases) {
    u32[5] = sample.clipsNear ? 1 : 0;
    device.queue.writeBuffer(bounds, 0, descriptor);
    const etat = new Uint32Array(stateWords);
    etat[stTested] = 1;
    device.queue.writeBuffer(state, 0, etat);
    const pyramid = device.createBuffer({
      size: sample.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(pyramid, 0, new Float32Array(sample.data));
    const group = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: pyramid } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: uniform, size: 256 } },
        { binding: 3, resource: { buffer: bounds } },
        { binding: 4, resource: { buffer: flags } },
        { binding: 5, resource: { buffer: state } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group, [0]);
    pass.setBindGroup(1, pagesGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(flags, 0, readback, 0, 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const flag = new Uint32Array(readback.getMappedRange().slice(0))[0];
    readback.unmap();
    results.push({ name: sample.name, expected: sample.expected, flag });
    pyramid.destroy();
  }
  await device.queue.onSubmittedWorkDone();
  texture.destroy();
  uniform.destroy();
  bounds.destroy();
  flags.destroy();
  state.destroy();
  pages.destroy();
  readback.destroy();
  device.destroy();
  return { adapter: adapterInfo, results, errors };
}
