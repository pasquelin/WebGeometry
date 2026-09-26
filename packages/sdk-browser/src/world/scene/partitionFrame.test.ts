import test from 'node:test';
import assert from 'node:assert/strict';
import type { RenderBackend } from '../../backend/types.ts';
import { hostFramingCamera } from '../../host/scene/graphObjects.ts';
import type { TableCell } from '../../../../sdk-core/src/scene/core/tablePartition.ts';
import { Group } from '../../../../sdk-core/src/world/object/object3d.ts';
import { createPartitionCells, type PartitionCells } from '../../scene/partition/cells.ts';
import { cellReach } from '../../scene/partition/plan.ts';
import { placedMesh } from '../../scene/partition/rows.ts';
import { PRIORITY_PREFETCH, PRIORITY_VISIBLE } from '../../streaming/priority.ts';
import type { createPageStreamer } from '../../streaming/pageStreamer.ts';
import { createPartitionFrame, primePartitions } from './partitionFrame.ts';

type Io = Parameters<PartitionCells['frame']>[2];
/** No arrival budget: what a test places never depends on the time the machine takes. */
const budget = { admits: () => true, spend() {} };

/** Cells that record what a frame hands them, and ask for one cell visible and one ahead. */
function recording() {
  const seen: { eye: number[]; reach: number; io: Io }[] = [];
  const cells = {
    frame(eye: number[], reach: number, io: Io) {
      seen.push({ eye: [...eye], reach, io });
      io.request(['near.json'], false);
      io.request(['ahead.json'], true);
    },
  } as unknown as PartitionCells;
  return { cells, seen };
}

function streamer() {
  const asked: [readonly string[], number][] = [];
  const port = {
    request: async (urls: readonly string[], options: { priority: number }) =>
      void asked.push([urls, options.priority]),
    getBytes: () => undefined,
    loading: () => false,
  } as unknown as ReturnType<typeof createPageStreamer>;
  return { port, asked };
}

test('no partition, no step before the frame', () => {
  const frame = createPartitionFrame({
    partitions: [],
    streamer: streamer().port,
    camera: hostFramingCamera(60, 1, 0.1, 100),
    active: () => ({}) as RenderBackend,
    budget,
  });
  assert.equal(frame, null);
});

test('a frame reads the cells within the far plane of its camera, visible first then ahead', () => {
  const { cells, seen } = recording();
  const { port, asked } = streamer();
  const camera = hostFramingCamera(60, 16 / 9, 0.1, 500);
  camera.position.set(3, 4, 5);
  createPartitionFrame({
    partitions: [cells],
    streamer: port,
    camera,
    active: () => ({}) as RenderBackend,
    budget,
  })!();
  assert.deepEqual(seen[0].eye, [3, 4, 5]);
  assert.equal(seen[0].reach, cellReach(camera));
  assert.deepEqual(asked, [
    [['near.json'], PRIORITY_VISIBLE],
    [['ahead.json'], PRIORITY_PREFETCH],
  ]);
});

/** What a first frame from `camera` asks of one cell of one node, boxed by `bounds` under the root. */
function asks(
  url: string,
  bounds: number[],
  camera: Parameters<typeof createPartitionFrame>[0]['camera'],
) {
  const cell = {
    url,
    sha256: '',
    bytes: 1,
    meshes: [[0, 1] as const],
    parents: [[null, bounds] as const],
  };
  const cells = createPartitionCells({
    partition: { bounds, meshes: [0], cells: [cell] },
    base: 'https://cache.test/key/',
    root: new Group(),
    parents: [],
    meshes: new Map([[0, placedMesh([{ meshes: 0, primitives: 0 }])]]),
  });
  const { port, asked } = streamer();
  const active = () => ({}) as RenderBackend;
  createPartitionFrame({ partitions: [cells], streamer: port, camera, active, budget })!();
  return asked;
}

test('a pebble far below any error target is read while the far plane lets it be drawn', () => {
  // Nothing coarser stands for an unread cell before #23: a small object within the far plane is
  // read whatever it projects to, or it would be missing from the image for good.
  const camera = hostFramingCamera(60, 16 / 9, 0.1, 300);
  assert.deepEqual(asks('pebble.json', [200, 0, 0, 200.01, 0.01, 0.01], camera), [
    [['https://cache.test/key/pebble.json'], PRIORITY_VISIBLE],
  ]);
});

test('a camera zoomed out, or scaled up, reads the cells its wider frustum sees', () => {
  // At zoom 0.5 the frustum is twice as wide, scaled twice it draws twice as far: a pebble 560 m
  // aside, 290 m ahead, is within either's reach, past the read-ahead of the camera at zoom 1.
  const bounds = [560, 0, -290, 560.01, 0.01, -289.99];
  const seen = [['https://cache.test/key/aside.json'], PRIORITY_VISIBLE];
  const camera = hostFramingCamera(60, 16 / 9, 0.1, 300);
  assert.deepEqual(asks('aside.json', bounds, camera), []);
  camera.zoom = 0.5;
  assert.deepEqual(asks('aside.json', bounds, camera), [seen]);
  camera.zoom = 1;
  (camera as unknown as Group).scale.set(2, 2, 2);
  assert.deepEqual(asks('aside.json', bounds, camera), [seen]);
});

test('a reach past the rows sized at open asks the owner to open the session again', () => {
  const renew = () => {};
  const { cells, seen } = recording();
  createPartitionFrame({
    partitions: [cells],
    streamer: streamer().port,
    camera: hostFramingCamera(60, 1, 0.1, 100),
    active: () => ({}) as RenderBackend,
    budget,
    renew,
  })!();
  assert.equal(seen[0].io.outgrown, renew);
});

/** A grid of `side`² cells ten metres wide, each placing four nodes of one of two meshes. */
function grid(side: number) {
  const cells: TableCell[] = [];
  const bodies = new Map<string, Uint8Array>();
  for (let x = 0; x < side; x++)
    for (let z = 0; z < side; z++) {
      const url = `https://cache.test/key/cell-${x}-${z}.json`;
      const mesh = (x + z) % 2;
      const nodes = [0, 1, 2, 3].map((at) => ({
        parent: null,
        mesh,
        matrix: null,
        translation: [x * 10 + at * 2, 0, z * 10 + at * 2],
        rotation: null,
        scale: null,
      }));
      bodies.set(url, new TextEncoder().encode(JSON.stringify({ version: 2, nodes })));
      const bounds = [x * 10, 0, z * 10, x * 10 + 8, 1, z * 10 + 8];
      cells.push({ url, sha256: '', bytes: 1, parents: [[null, bounds]], meshes: [[mesh, 4]] });
    }
  const partition = {
    bounds: [0, 0, 0, side * 10, 1, side * 10],
    meshes: [0, 1],
    cells,
  };
  const meshes = new Map([0, 1].map((rank) => [rank, placedMesh([{ meshes: rank }])]));
  const port = {
    readBytes: async (url: string) => bodies.get(url)!,
    getBytes: (url: string) => bodies.get(url),
    loading: () => false,
    request: async () => {},
  } as unknown as ReturnType<typeof createPageStreamer>;
  const root = new Group();
  const partitioned = createPartitionCells({
    partition,
    base: 'https://cache.test/key/',
    root,
    parents: [],
    meshes,
  });
  return { partitioned, port };
}

test('on a WebGPU session, which grows no buffer, a walk never leaves a cell waiting for rows', async () => {
  // Its engine cannot grow rows in place, and the reach stays the one the rows were sized for.
  const { partitioned, port } = grid(24);
  const camera = hostFramingCamera(60, 16 / 9, 0.1, 30);
  camera.position.set(5, 2, 5);
  await primePartitions([partitioned], camera, port, true);
  const frame = createPartitionFrame({
    partitions: [partitioned],
    streamer: port,
    camera,
    active: () => ({}) as RenderBackend,
    budget,
  })!;
  for (let step = 0; step <= 46; step++) {
    camera.position.set(5 + step * 5, 2, 5 + step * 5);
    camera.updateMatrixWorld();
    frame();
    assert.equal(partitioned.stats().waiting, 0, `step ${step}`);
  }
  assert.ok(partitioned.stats().held > 1, 'the cells around the camera are placed');
});
