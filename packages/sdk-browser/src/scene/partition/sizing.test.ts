import test from 'node:test';
import assert from 'node:assert/strict';
import type { TableCell } from '../../../../sdk-core/src/scene/core/tablePartition.ts';
import { Group, Object3D } from '../../../../sdk-core/src/world/object/object3d.ts';
import { createPartitionCells } from './cells.ts';
import { KEEP } from './plan.ts';
import { placedMesh } from './rows.ts';
import { residentRows } from './sizing.ts';

const cell = (x: number) => ({
  parents: [[null, [x, 0, 0, x + 1, 1, 1]] as const],
  meshes: [[0, 1] as const],
});

test('the rows held at once follow the reach, mesh by mesh, and not the length of the world', () => {
  // A row of unit cells one metre apart, each placing one node of mesh 0; every tenth also two of
  // mesh 1. Two cells can be held together while their gap is within twice the keep radius.
  const row = (length: number) =>
    Array.from({ length }, (_, at) => {
      const placed = cell(2 * at);
      return at % 10 ? placed : { ...placed, meshes: [[0, 1] as const, [1, 2] as const] };
    });
  const reach = 10,
    none = new Map();
  const short = residentRows(row(100), reach, none),
    long = residentRows(row(1600), reach, none);
  assert.deepEqual([...long], [...short], 'sixteen times the world, the same rows');
  // Cells within 2·reach·(1 + KEEP) = 30 m of one another, 2 m apart: fifteen on each side.
  const span = Math.floor((2 * reach * (1 + KEEP)) / 2);
  assert.equal(short.get(0), 2 * span + 1);
  assert.ok(short.get(1)! >= 2 && short.get(1)! <= 2 * Math.ceil((2 * span + 1) / 10));
  // An orthographic camera reads every cell: its rows hold the world.
  assert.equal(residentRows(row(100), Infinity, none).get(0), 100);
});

/** Two core parents, each a row of ten one-node cells 100 m apart in its own frame; the second
 *  parent stands 10 km off, so no eye sees both rows where the file puts them. */
function twoRows() {
  const bodies = new Map<string, Uint8Array>();
  const cells: TableCell[] = [];
  for (const parent of [0, 1])
    for (let at = 0; at < 10; at++) {
      const url = `https://cache.test/key/${parent}-${at}.json`;
      const node = { parent, mesh: 0, matrix: null, translation: [100 * at, 0, 0] };
      const nodes = [{ ...node, rotation: null, scale: null }];
      bodies.set(url, new TextEncoder().encode(JSON.stringify({ version: 2, nodes })));
      const box = [100 * at, 0, 0, 100 * at + 1, 1, 1];
      cells.push({ url, sha256: '', bytes: 1, parents: [[parent, box]], meshes: [[0, 1]] });
    }
  const root = new Group();
  const parents = [new Object3D(), new Object3D()];
  parents.forEach((parent) => root.add(parent));
  parents[1].position.set(0, 1e4, 0);
  const partitioned = createPartitionCells({
    partition: { bounds: [0, 0, 0, 901, 1e4 + 1, 1], meshes: [0], cells },
    base: 'https://cache.test/key/',
    root,
    parents,
    meshes: new Map([[0, placedMesh([{ meshes: 0 }])]]),
  });
  let reopened = 0;
  const io = {
    bytes: (url: string) => bodies.get(url),
    loading: () => false,
    request() {},
    update() {},
    outgrown: () => void reopened++,
  };
  const budget = { admits: () => true, spend() {} };
  const frame = (x: number) => partitioned.frame([x, 0.5, 0.5], 10, io, budget);
  const opened = () => partitioned.prime([0, 0.5, 0.5], 10, async (url) => bodies.get(url)!, true);
  return { partitioned, parents, frame, opened, reopened: () => reopened };
}

test('parents a page moves together never run the rows short: no reopen, nothing undrawn', async () => {
  const { partitioned, parents, frame, opened, reopened } = twoRows();
  await opened();
  const { rows } = partitioned.stats();
  assert.ok(rows >= 2 && rows < 20, `${rows} rows: one cell of each parent, not the world`);
  const walk = (label: string) => {
    for (let x = 0; x <= 900; x += 50) {
      frame(x);
      const { waiting, held } = partitioned.stats();
      assert.deepEqual([waiting, reopened()], [0, 0], `${label}, eye at ${x}`);
      if (x % 100 === 0) assert.ok(held >= (label === 'moved together' ? 2 : 1), label);
    }
  };
  walk('apart');
  // The page brings the second row onto the first: both cells at every stop are placed at once.
  parents[1].position.set(0, 0, 0);
  walk('moved together');
  // Turned a twelfth of a turn, its stretch rounded but unchanged: the rows still hold.
  parents[1].rotation.set(0, Math.PI / 6, 0);
  walk('turned');
  assert.equal(partitioned.stats().rows, rows, 'nothing grew');
});

test('a parent scaled up spreads its cells: the rows still hold, no reopen', async () => {
  const { partitioned, parents, frame, opened, reopened } = twoRows();
  await opened();
  const { rows } = partitioned.stats();
  // Brought onto the first row and doubled: its cells stand 200 m apart, never closer.
  parents[1].position.set(0, 0, 0);
  parents[1].scale.set(2, 2, 2);
  for (let x = 0; x <= 1800; x += 50) {
    frame(x);
    assert.deepEqual([partitioned.stats().waiting, reopened()], [0, 0], `eye at ${x}`);
  }
  assert.equal(partitioned.stats().rows, rows, 'nothing grew');
});

test('a parent scaled below its stretch at open asks the owner, like a reach past the rows', async () => {
  const { parents, frame, opened, reopened } = twoRows();
  await opened();
  parents[1].scale.set(0.5, 0.5, 0.5);
  frame(0);
  frame(0);
  assert.equal(reopened(), 1, 'asked once');
});

test('a parent stretched unevenly past its stretch at open asks the owner once', async () => {
  const { parents, frame, opened, reopened } = twoRows();
  await opened();
  // Its least stretch stays 1, its most doubles: its boxes widen past what the rows counted.
  parents[1].scale.set(2, 1, 1);
  frame(0);
  frame(0);
  assert.equal(reopened(), 1, 'asked once');
});
