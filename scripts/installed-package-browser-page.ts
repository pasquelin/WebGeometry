// Runs inside the browser page (`page.evaluate`): DOM globals (`location`, `devicePixelRatio`,
// `crypto.subtle`, `Worker`) are ambient.
import type {
  EvaluatedInstalledPage,
  LooseSdk,
  LooseWorld,
} from './installed-package-browser-page-types.ts';

export type { EvaluatedInstalledPage } from './installed-package-browser-page-types.ts';

export async function evaluateInstalledPage({
  moduleName,
  manifestUrl,
  replayUrl,
  commonWorkerPath,
}: {
  moduleName: string | null;
  manifestUrl: string;
  replayUrl: string;
  commonWorkerPath: string;
}): Promise<EvaluatedInstalledPage> {
  const deadline = performance.now() + 10_000;
  while (!moduleName && !globalThis.__installedSdk && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const sdk: LooseSdk | undefined = moduleName
    ? ((await import(moduleName)) as LooseSdk)
    : globalThis.__installedSdk;
  if (!sdk) throw new Error('installed explorer bundle did not start');
  const count = 2;
  const views = (buffer: Float64Array, stride: number): Float64Array[] =>
    Array.from({ length: count }, (_, index) =>
      buffer.subarray(index * stride, (index + 1) * stride),
    );
  const world = new Float64Array(count * sdk.MATRIX_VALUES);
  sdk.hierarchyUpdateBatch(
    views(world, sdk.MATRIX_VALUES),
    views(new Float64Array([2, 3, 4, 5, 7, 11]), sdk.POSITION_VALUES),
    views(new Float64Array([0, 0, 0, 1, 0, 0, 0, 1]), sdk.QUATERNION_VALUES),
    views(new Float64Array(6).fill(1), sdk.POSITION_VALUES),
    new Uint32Array([sdk.HIERARCHY_ROOT, 0]),
    count,
    new Float64Array(sdk.MATRIX_VALUES),
  );
  const hierarchy = { world: Array.from(world.subarray(28, 31)), parent: 0 };
  if (hierarchy.world.join(',') !== '7,10,15')
    throw new Error('installed browser hierarchy did not execute');
  const commonWorker = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(commonWorkerPath, { type: 'module' });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('installed common worker timed out'));
    }, 30_000);
    worker.onmessage = ({ data }) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(data);
    };
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message));
    };
  });
  // A world on the page's canvas, the compiled model loaded into it, framed by its own bounds
  // and drawn at a zero pixel error once the pages the view reads are resident.
  const open = async (target: string, url: string) => {
    const world = sdk.createWorld(target, { interactive: false });
    await world.ready;
    const model = await world.scene.load(url);
    const view = sdk.pose.fromBounds(model.bounds, {
      aspect: world.canvas.width / Math.max(1, world.canvas.height),
    });
    world.camera.set(view);
    world.pixelError = 0;
    await world.awaitPages();
    // A session that failed to open is named with its cause, never met later as a world that
    // "draws nothing yet" (#568); `page.evaluate` carries only the message out.
    const failure = world.diagnostic.error;
    if (failure) {
      const cause = failure.details?.cause;
      throw new Error(
        `installed world ${target} did not open: ${failure.message}${cause === undefined ? '' : ` (${String(cause)})`}`,
      );
    }
    world.render();
    return { world, view, metrics: sdk.metric.frame(world) };
  };
  const primer = await open('primer', manifestUrl);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const replay = await open('replay', replayUrl);
  const samples = [primer, replay].map((item) => item.metrics);
  const value: Record<string, number> = { ...samples[1] };
  for (const key of ['pagesDecodedOffThread', 'pagesDecodedWasm', 'pagesPlannedOffThread'])
    value[key] = Math.max(...samples.map((sample) => sample?.[key] ?? 0));
  const pointerUrl = new URL(manifestUrl, location.href);
  const pointer = (await (await fetch(pointerUrl)).json()) as { url: string };
  const metadataUrl = new URL(pointer.url, pointerUrl);
  const root: unknown = await (await fetch(metadataUrl)).json();
  const metadata = await sdk.readPagedManifest(
    root,
    async ({ url }) => new Uint8Array(await (await fetch(new URL(url, metadataUrl))).arrayBuffer()),
  );
  const geometry = metadata.primitives
    .flatMap((primitive) => primitive.pages)
    .find((item) => item.geometry)?.geometry;
  if (!geometry) throw new Error('installed cache carries no geometry page');
  const size = { width: replay.world.canvas.width, height: replay.world.canvas.height };
  const read = async (world: LooseWorld) => (await sdk.capture.buffer(world, size)).data;
  const capture = await read(replay.world);
  replay.world.render();
  const repeated = await read(replay.world);
  let aaDifferentPixels = 0;
  for (let index = 0; index < capture.length; index += 4)
    if (
      capture[index] !== repeated[index] ||
      capture[index + 1] !== repeated[index + 1] ||
      capture[index + 2] !== repeated[index + 2] ||
      capture[index + 3] !== repeated[index + 3]
    )
      aaDifferentPixels++;
  const hash = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  const captureEvidence = {
    sha256: await hash(capture),
    repeatedSha256: await hash(repeated),
    aaDifferentPixels,
    byteLength: capture.byteLength,
    width: size.width,
    height: size.height,
    dpr: devicePixelRatio,
    pixelError: 0,
    camera: replay.view,
    capabilities: { renderer: replay.world.renderer },
  };
  // An engine that publishes no drawn cut (WebGL2) draws what it submits.
  value.drawnTriangles ??= value.submittedTriangles;
  replay.world.dispose();
  primer.world.dispose();
  return {
    metrics: value,
    capture: captureEvidence,
    geometryUrl: new URL(geometry.url, metadataUrl).href,
    hierarchy,
    commonWorker,
  };
}
