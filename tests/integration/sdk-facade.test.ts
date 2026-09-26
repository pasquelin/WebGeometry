import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as common from '../../packages/sdk/index.ts';
import * as core from '../../packages/sdk-core/src/index.ts';
import * as browser from '../../packages/sdk/browser.ts';
import * as browserLegacy from '../../packages/sdk-browser/src/index.ts';

test('the facade keeps canonical binding identity across environments', () => {
  assert.equal(common.LOD_QUALITY, core.LOD_QUALITY);
  assert.equal(browser.LOD_QUALITY, core.LOD_QUALITY);
  assert.equal(browser.createWorld, browserLegacy.createWorld);
});

test('importing each facade starts no browser resource or native process', () => {
  for (const entry of ['index.ts', 'browser.ts', 'node.mts']) {
    const url = new URL(`../../packages/sdk/${entry}`, import.meta.url).href;
    const probe = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const forbidden = (name) => () => { throw new Error('Import initialized ' + name); };
      for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
        childProcess[name] = forbidden(name);
      syncBuiltinESMExports();
      for (const name of ['Worker', 'SharedWorker', 'OffscreenCanvas', 'AudioContext'])
        globalThis[name] = function () { throw new Error('Import constructed ' + name); };
      globalThis.window = undefined;
      for (const name of ['document', 'navigator'])
        Object.defineProperty(globalThis, name, { configurable: true, get: forbidden(name) });
      globalThis.requestAnimationFrame = forbidden('requestAnimationFrame');
      globalThis.fetch = forbidden('fetch');
      await import(${JSON.stringify(url)});
    `;
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', probe],
      {
        timeout: 30_000,
        stdio: 'pipe',
      },
    );
  }
});

test('the five-import hierarchy example composes parents before children', () => {
  const {
    HIERARCHY_ROOT,
    MATRIX_VALUES,
    POSITION_VALUES,
    QUATERNION_VALUES,
    hierarchyUpdateBatch,
  } = common;
  const count = 3;
  // The guide's five-import example, run as written: the portal demo (`site/demos/batch.ts`) shows its own copy.
  // jscpd:ignore-start
  const views = (buffer: Float64Array, stride: number): Float64Array[] =>
    Array.from({ length: count }, (_, index) =>
      buffer.subarray(index * stride, (index + 1) * stride),
    );
  const world = new Float64Array(count * MATRIX_VALUES);
  const positions = new Float64Array(count * POSITION_VALUES);
  const rotations = new Float64Array(count * QUATERNION_VALUES);
  const scales = new Float64Array(count * POSITION_VALUES).fill(1);
  // jscpd:ignore-end
  const parents = new Uint32Array([HIERARCHY_ROOT, 0, 1]);
  rotations[3] = rotations[7] = rotations[11] = 1;
  positions[0] = 2;
  positions[3] = 3;
  positions[6] = 5;
  hierarchyUpdateBatch(
    views(world, MATRIX_VALUES),
    views(positions, POSITION_VALUES),
    views(rotations, QUATERNION_VALUES),
    views(scales, POSITION_VALUES),
    parents,
    count,
    new Float64Array(MATRIX_VALUES),
  );
  assert.deepEqual([world[12], world[28], world[44]], [2, 5, 10]);
});

interface InventoryEntry {
  name: string;
  kind: string;
  disposition?: string;
  bindingIdentity: string;
  currentEntryPoints: string[];
}
interface Inventory {
  exports: InventoryEntry[];
  collisions: unknown[];
  shadowed: { name: string }[];
}

test('generated inventory and explicit facade files are current', async () => {
  const inventory: Inventory = JSON.parse(
    await readFile(new URL('../../site/data/api-inventory.json', import.meta.url), 'utf8'),
  );
  assert.equal(inventory.exports.length, 749);
  assert.deepEqual(inventory.collisions, []);
  // The page words of the world families shadow the engine contracts of the same name in the
  // browser condition; the inventory names every such pair.
  assert.deepEqual(
    inventory.shadowed.map((entry) => entry.name),
    ['CameraPose', 'Material', 'Primitive', 'Scene', 'Side', 'Texture'],
  );
  assert.ok(inventory.exports.every((entry) => !entry.bindingIdentity.includes(process.cwd())));
  assert.ok(inventory.exports.every((entry) => !entry.bindingIdentity.includes('file://')));
  assert.ok(
    inventory.exports.some(
      (entry) => entry.name === 'sideOf' && entry.disposition === 'newly exposed',
    ),
  );
  for (const name of ['openMeasuredWorld', 'MeasuredWorld', 'MeasuredWorldOptions'])
    assert.ok(
      !inventory.exports.some((row) => row.name === name),
      `${name} belongs to the measurement entry, not the package`,
    );
  // The world's side of a joint, typed on its member (#558, #795): no page names it.
  assert.ok(!inventory.exports.some((row) => row.name === 'JointHost'), 'JointHost is internal');
  for (const [name, entryPoint] of [
    ['CameraPose', 'trillion3d (common)'],
    ['CameraPose', 'trillion3d (browser condition)'],
    ['JobSnapshot', 'trillion3d (common)'],
    ['World', 'trillion3d (browser condition)'],
    ['WorldOptions', 'trillion3d (browser condition)'],
    ['CompilationJob', 'trillion3d (node condition)'],
    ['CompilationResult', 'trillion3d (node condition)'],
    ['PrepareOptions', 'trillion3d (node condition)'],
  ]) {
    const entry = inventory.exports.find(
      (row) => row.name === name && row.currentEntryPoints.includes(entryPoint),
    );
    assert.ok(entry, `${name} is missing from the inventory`);
    assert.equal(entry.kind, 'type', `${name} must remain a named public type`);
    assert.ok(
      entry.currentEntryPoints.includes(entryPoint),
      `${name} must remain reachable from ${entryPoint}`,
    );
  }
});

test('a maths-only bundle keeps baseline bytes and excludes platform modules', async () => {
  const bundle = (entry: string) =>
    build({
      stdin: {
        contents: `import { hierarchyUpdateBatch } from '${entry}'; console.log(hierarchyUpdateBatch);`,
        resolveDir: new URL('../..', import.meta.url).pathname,
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      treeShaking: true,
      minify: true,
    });
  const baseline = await bundle('./packages/sdk-core/src/index.ts');
  const proposed = await bundle('./packages/sdk/index.ts');
  const browserProposed = await bundle('./packages/sdk/browser.ts');
  const inputs = Object.keys(proposed.metafile.inputs);
  assert.ok(inputs.some((path) => path.endsWith('/math/batch/batch.ts')));
  assert.ok(!inputs.some((path) => path.includes('/sdk-browser/') || path.includes('/sdk-node/')));
  assert.equal(baseline.outputFiles[0].contents.length, 5_044);
  assert.equal(proposed.outputFiles[0].contents.length, 1_780);
  assert.equal(browserProposed.outputFiles[0].contents.length, 3_329);
  assert.ok(
    !Object.keys(browserProposed.metafile.inputs).some((path) => path.includes('/sdk-node/')),
  );
  const browserOutput = Object.values(browserProposed.metafile.outputs)[0];
  assert.ok(
    !Object.entries(browserOutput.inputs).some(
      ([path, contribution]) => path.includes('/sdk-browser/') && contribution.bytesInOutput > 0,
    ),
  );
});
