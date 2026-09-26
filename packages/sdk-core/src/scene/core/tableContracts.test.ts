import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSceneTables } from './tableContracts.ts';
import { assertCellNodes, readTablePartition, type TablePage } from './tablePartition.ts';

const hasCode =
  (code: string, text = '') =>
  (error: unknown) =>
    (error as { code?: string }).code === code && (error as Error).message.includes(text);

/** Tables at the versions this runtime reads, every table empty. */
const tables = () => ({
  version: 4,
  nodeTableVersion: 3,
  materialTableVersion: 4,
  geometryTableVersion: 1,
  scene: { name: null, nodes: [] },
  nodes: [],
  lights: [],
  cameras: [],
  materials: [],
  textures: [],
  documents: {},
  partition: null,
});

test('tables of an unknown version are refused rather than half-read', () => {
  assert.doesNotThrow(() => assertSceneTables(tables()));
  for (const field of ['version', 'nodeTableVersion', 'materialTableVersion'] as const)
    assert.throws(
      () => assertSceneTables({ ...tables(), [field]: 1 }),
      hasCode('UNSUPPORTED_SCENE_TABLES', `${field} 1`),
    );
  assert.throws(
    () => assertSceneTables({ ...tables(), geometryTableVersion: 99 }),
    hasCode('UNSUPPORTED_SCENE_TABLES', 'geometryTableVersion 99'),
  );
  // Issue #275: the refusal says what to do — recompile the cache, and with which command.
  assert.throws(
    () => assertSceneTables({ ...tables(), materialTableVersion: 3 }),
    hasCode(
      'UNSUPPORTED_SCENE_TABLES',
      'recompile it with this one (pnpm run build:native, then trillion3d-compiler',
    ),
  );
  assert.throws(() => assertSceneTables(null), hasCode('INVALID_SCENE_TABLES'));
});

/** A slot naming the page whose digest ends in `digest`, boxed by `box`, as the compiler writes it. */
function slot(digest: string, box: number[]) {
  const bits = new DataView(new ArrayBuffer(8));
  const hex = (value: number) => (bits.setFloat64(0, value), bits.getBigUint64(0).toString(16));
  return `${digest.padStart(64, '0')}00000001${box.map((v) => hex(v).padStart(16, '0')).join('')}`;
}
const EMPTY = '0'.repeat(168);
const cells = (...ranks: number[]) =>
  ranks.map((at) => ({ url: `${at}`, parents: [], meshes: [[at, 1]] }));

test('a partition root of another version or shape is refused, and a cell is read only at its own', () => {
  const partition = { version: 3, pages: Array(8).fill(EMPTY) };
  assert.deepEqual(assertSceneTables({ ...tables(), partition }).partition, partition);
  assert.throws(
    () => assertSceneTables({ ...tables(), partition: { ...partition, version: 2 } }),
    hasCode('UNSUPPORTED_SCENE_TABLES', 'partition version 2'),
  );
  // A root is a fixed number of slots: fewer is not a root this runtime reads.
  assert.throws(
    () => assertSceneTables({ ...tables(), partition: { ...partition, pages: [EMPTY] } }),
    hasCode('INVALID_SCENE_TABLES'),
  );
  assert.deepEqual(assertCellNodes({ version: 3, nodes: [] }), []);
  assert.throws(() => assertCellNodes({ version: 2, nodes: [] }), hasCode('INVALID_SCENE_TABLES'));
});

test('the pages under the root give back every cell in order, their box, meshes and mesh pages', async () => {
  // The root names an index page `a` and a region page `b`; `a` names the region pages `c`, `d`.
  const [m, n] = [slot('e', [0, 0, 0, 0, 0, 0]), slot('f', [0, 0, 0, 0, 0, 0])];
  const bodies: Record<string, unknown> = {
    a: { version: 3, pages: [slot('c', [0, 0, 0, 1, 1, 1]), slot('d', [1, 0, 0, 2, 1, 1])] },
    b: { version: 3, cells: cells(3), meshPages: [n] },
    c: { version: 3, cells: cells(0, 1), meshPages: [m, n] },
    d: { version: 3, cells: cells(2), meshPages: [] },
  };
  const read = async ({ sha256, url }: TablePage) => {
    assert.equal(url, `scene-page-${sha256}.json`);
    return new TextEncoder().encode(JSON.stringify(bodies[sha256.replace(/^0+/, '')]));
  };
  const [a, b] = [slot('a', [0, 0, 0, 2, 1, 1]), slot('b', [-3, 0, 0, -2, 5, 1])];
  const root = [a, b, ...Array(6).fill(EMPTY)];
  const paged = await readTablePartition({ version: 3, pages: root }, read);
  const urls = paged.cells.map(({ url }) => url);
  assert.deepEqual(urls, ['0', '1', '2', '3']);
  assert.deepEqual(paged.bounds, [-3, 0, 0, 2, 5, 1]);
  assert.deepEqual(paged.meshes, [0, 1, 2, 3]);
  const regions = [
    { cells: 2, meshPages: [m, n] },
    { cells: 1, meshPages: [] },
  ];
  assert.deepEqual(paged.regions, [...regions, { cells: 1, meshPages: [n] }]);
  // A slot that is not fixed-width hexadecimal, or a page of another version, is refused.
  const bad = { version: 3, pages: ['z'.repeat(168), ...root.slice(1)] };
  await assert.rejects(readTablePartition(bad, read), hasCode('INVALID_SCENE_TABLES'));
  const again = () => readTablePartition({ version: 3, pages: root }, read);
  bodies.b = { version: 2, cells: [] };
  await assert.rejects(again(), hasCode('UNSUPPORTED_SCENE_TABLES', 'version 2'));
  bodies.b = { version: 3 }; // Neither pages nor cells: refused, never an empty region.
  await assert.rejects(again(), hasCode('INVALID_SCENE_TABLES'));
  bodies.b = { version: 3, cells: cells(3), meshPages: ['e'] }; // A mesh page that is no slot.
  await assert.rejects(again(), hasCode('INVALID_SCENE_TABLES', 'mesh pages'));
});
