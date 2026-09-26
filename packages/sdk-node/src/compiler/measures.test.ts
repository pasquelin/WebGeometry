import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepare } from '../index.mts';
import { manifest as fixture } from '../../../../tests/fixtures/manifestBinary.ts';
import { writePagedManifest } from '../../../../tests/fixtures/pagedManifest.ts';

/** The `prepare()` metrics of a run that built the hierarchy, as the manifest/pointer merge
 *  produces them in practice: not part of `CompilationResult`'s narrow declared shape, only
 *  reachable through its index signature. */
interface PrepareMetrics {
  importMs: number;
  compileMs: number;
  pruneMs: number;
  wallMs: number;
}

/** The metrics of a run that found its folder reused instead: the build-only fields are absent. */
interface ReusedPrepareMetrics {
  wallMs: number;
  clusterHierarchyPagesMs: number | null;
  compileMs?: number;
  phaseElapsedMs?: number;
}

/** The real compiler, where `pnpm run build:native` drops it. */
function compilerBinary(): string | undefined {
  const target = fileURLToPath(new URL('../../../asset-compiler-rust/target/', import.meta.url));
  return ['release', 'debug']
    .map((profile) => join(target, profile, 'trillion3d-compiler'))
    .find((path) => existsSync(path));
}
/** A quad on disk: the smallest source the compiler accepts. */
async function quad(root: string): Promise<string> {
  const source = join(root, 'quad.obj');
  await writeFile(source, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nvn 0 0 1\nf 1//1 2//1 4//1 3//1\n');
  return source;
}

// V02: the manifest is written before the prune and therefore cannot carry the job duration; the
// pointer is returned after. `prepare()` used to read the manifest alone and lost the two final
// measurements. The full public path, against the real binary, must return both together.
test('V02 prepare() returns the pointer’s final measurements with the manifest’s', async (t) => {
  const executable = compilerBinary();
  if (!executable) return t.skip('native compiler missing: run `pnpm run build:native`');
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-mesures-'));
  try {
    const result = await prepare(await quad(root), join(root, 'cache'), 'full', 150000, {
      executable,
      resourceBaseUrl: '/assets/',
    });
    const { importMs, compileMs, pruneMs, wallMs } = result.metrics as PrepareMetrics;
    for (const [name, value] of Object.entries({ importMs, compileMs, pruneMs, wallMs }))
      assert.equal(
        typeof value,
        'number',
        `${name} missing from ${JSON.stringify(result.metrics)}`,
      );
    // The announced duration covers formatting the manifest and the prune that follows it.
    assert.ok(wallMs >= compileMs + pruneMs, `${wallMs} ms under ${compileMs} + ${pruneMs} ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// #47: the same source prepared twice into one cache finds its folder proven and kept; the
// result says so, and the hierarchy duration of a run that built none stays `null`.
test('prepare() reports the folder reused by a second identical run', async (t) => {
  const executable = compilerBinary();
  if (!executable) return t.skip('native compiler missing: run `pnpm run build:native`');
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-reuse-'));
  try {
    const source = await quad(root);
    const options = { executable, resourceBaseUrl: '/assets/' };
    const first = await prepare(source, join(root, 'cache'), 'full', 150000, options);
    assert.equal(first.reused, null);
    const second = await prepare(source, join(root, 'cache'), 'full', 150000, options);
    assert.equal(second.key, first.key);
    assert.ok(second.reused);
    assert.ok(second.reused.objects > 0, JSON.stringify(second.reused));
    assert.equal(typeof second.reused.validateMs, 'number');
    const metrics = second.metrics as ReusedPrepareMetrics;
    assert.equal(typeof metrics.wallMs, 'number');
    // The manifest on disk still says how long the first run clustered; this run did not, and
    // none of that compile's durations is passed off as this run's.
    assert.equal(metrics.clusterHierarchyPagesMs, null);
    assert.equal(metrics.compileMs, undefined);
    assert.equal(metrics.phaseElapsedMs, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

interface FauxPointer {
  status: string;
  scope: string;
  url: string;
  pointer: string;
  cache: string;
  metrics: { importMs: number; wallMs: number; pruneMs: number };
}

/**
 * A stub compiler: the manifest of `metrics` is paged in beforehand, then the stub announces the
 * pointer. It pins both readings, which the real binary cannot, and makes the merge rule observable.
 */
async function faux(root: string, metrics: object, pointeur: FauxPointer): Promise<string> {
  const paged = { ...fixture(), primitives: [], metrics };
  await writePagedManifest(join(root, 'cache', 'native', pointeur.scope), paged, pointeur.url);
  const chemin = join(root, 'faux-compilateur.ts');
  await writeFile(
    chemin,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(pointeur))});
`,
    { mode: 0o755 },
  );
  return chemin;
}

test('the manifest keeps priority, the pointer fills in the final measurements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-fusion-'));
  try {
    const pointeur = {
      status: 'ready',
      scope: 'full',
      url: 'quad.json',
      pointer: 'quad',
      cache: 'c',
      metrics: { importMs: 999, wallMs: 40, pruneMs: 5 },
    };
    const result = await prepare(await quad(root), join(root, 'cache'), 'full', 150000, {
      executable: await faux(root, { importMs: 1, compileMs: 2 }, pointeur),
      resourceBaseUrl: '/assets/',
    });
    assert.deepEqual(result.metrics, { importMs: 1, compileMs: 2, wallMs: 40, pruneMs: 5 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
