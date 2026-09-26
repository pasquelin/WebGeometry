import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepare, prepareMany, createCompilationJob, COMPILER_LINE_LIMIT } from './index.mts';
import type { BatchSummary } from './compiler/contracts.ts';
import { manifest } from '../../../tests/fixtures/manifestBinary.ts';
import { writePagedManifest } from '../../../tests/fixtures/pagedManifest.ts';

/** A stand-in compiler that speaks the event protocol: events on stderr, a pointer on stdout, manifest on disk. */
async function fakeCompiler(root: string, body: string): Promise<string> {
  const executable = join(root, 'compiler');
  await writeFile(executable, `#!/usr/bin/env node\n${body}`);
  await chmod(executable, 0o755);
  return executable;
}
/** The cache the stand-in names, `k1` of both scopes: a paged manifest of seven triangles. */
async function writeCache(output: string) {
  const seven = { ...manifest(), selectedTriangles: 7, primitives: [] };
  for (const scope of ['slice', 'full'])
    await writePagedManifest(join(output, 'native', scope, 'k1'), seven);
}
const readyCompiler = `
const [input,output,scope]=process.argv.slice(2);
const path=require('node:path');
process.stderr.write(JSON.stringify({event:'accepted',job:'job'})+'\\n');
process.stderr.write(JSON.stringify({event:'progress',job:'job',phase:'import',completed:1,total:1})+'\\n');
process.stderr.write(JSON.stringify({event:'complete',job:'job'})+'\\n');
process.stdout.write(JSON.stringify({status:'ready',key:'k1',scope,url:'k1/clusters.json',pointer:path.join(output,'native',scope,'manifest.json'),cache:output})+'\\n');
`;
test('prepare relays events, reads the pointer from stdout and the manifest from disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-prepare-'));
  try {
    const executable = await fakeCompiler(root, readyCompiler);
    await writeCache(join(root, 'out'));
    const events: string[] = [];
    const result = await prepare(join(root, 'in'), join(root, 'out'), 'slice', 1, {
      executable,
      resourceBaseUrl: '/assets/',
      onProgress: (event) => events.push(event.event),
    });
    assert.deepEqual(events, ['accepted', 'progress', 'complete']);
    assert.equal(result.status, 'ready');
    assert.equal(result.selectedTriangles, 7);
    assert.equal(result.url, 'k1/clusters.json');
    assert.equal(result.cache, join(root, 'out'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('compilation job progress always has a phase, including compiler lifecycle events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-job-progress-'));
  try {
    const executable = await fakeCompiler(root, readyCompiler);
    await writeCache(join(root, 'out'));
    const phases: string[] = [];
    const job = await createCompilationJob('job', join(root, 'in'), join(root, 'out'), {
      executable,
      resourceBaseUrl: '/assets/',
      telemetry: (snapshot) => {
        if (snapshot.progress) phases.push(snapshot.progress.phase);
      },
    });
    await job.promise;
    assert.deepEqual(phases, ['accepted', 'import', 'complete', 'complete']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('prepare reports the compiler error code instead of a generic exit code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-error-'));
  try {
    const executable = await fakeCompiler(
      root,
      `process.stderr.write(JSON.stringify({event:'error',status:'error',job:'job',code:'EMPTY_SLICE',message:'x'})+'\\n');process.stdout.write(JSON.stringify({status:'error',code:'EMPTY_SLICE',message:'x'})+'\\n');process.exit(2);`,
    );
    await assert.rejects(
      prepare(join(root, 'in'), join(root, 'out'), 'slice', 1, {
        executable,
        resourceBaseUrl: '/assets/',
      }),
      (error) => String(error).includes('EMPTY_SLICE'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('prepare rejects a compiler line that never ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-line-'));
  try {
    const executable = await fakeCompiler(
      root,
      `process.stderr.write('x'.repeat(${COMPILER_LINE_LIMIT}+1));`,
    );
    await assert.rejects(
      prepare(join(root, 'in'), join(root, 'out'), 'slice', 1, {
        executable,
        resourceBaseUrl: '/assets/',
      }),
      (error) => String(error).includes('COMPILER_LINE_LIMIT'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('prepare writes a cancel line on stdin when the signal aborts, then kills after the grace period', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-cancel-'));
  try {
    const seen = join(root, 'stdin.txt');
    const executable = await fakeCompiler(
      root,
      `process.stdin.on('data',d=>{require('node:fs').writeFileSync(${JSON.stringify(seen)},String(d));process.stderr.write(JSON.stringify({event:'cancelled',status:'error',job:'job',code:'CANCELLED'})+'\\n');process.exit(2);});process.stderr.write(JSON.stringify({event:'accepted',job:'job'})+'\\n');setTimeout(()=>{},60000);`,
    );
    const controller = new AbortController();
    const promise = prepare(join(root, 'in'), join(root, 'out'), 'slice', 1, {
      executable,
      resourceBaseUrl: '/assets/',
      signal: controller.signal,
      onProgress: (event) => {
        if (event.event === 'accepted') controller.abort();
      },
    });
    await assert.rejects(promise, (error) => String(error).includes('CANCELLED'));
    assert.equal((await readFile(seen, 'utf8')).trim(), '{"cancel":"*"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('prepareMany hands the compiler one batch file and returns its summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trillion3d-batch-'));
  try {
    const executable = await fakeCompiler(
      root,
      `
const fs=require('node:fs');const [flag,file]=process.argv.slice(2);
const spec=JSON.parse(fs.readFileSync(file,'utf8'));
for(const job of spec.jobs)process.stderr.write(JSON.stringify({event:'queued',job:job.id})+'\\n');
process.stdout.write(JSON.stringify({status:'ready',completed:spec.jobs.length,failed:0,cancelled:0,workers:spec.workers,jobs:spec.jobs.map(j=>({job:j.id,status:'ready',pointer:{key:'k'}}))})+'\\n');`,
    );
    const events: string[] = [];
    const summary = await prepareMany(
      [
        { id: 'a', source: 's', cache: 'c', resourceBaseUrl: '/a/' },
        { id: 'b', source: 's', cache: 'c', resourceBaseUrl: '/b/' },
      ],
      { executable, workers: 2, onEvent: (event) => events.push(event.job) },
    );
    assert.deepEqual(events, ['a', 'b']);
    assert.equal(summary.status, 'ready');
    // The compiler's `workers` count is relayed straight through; `BatchSummary` does not declare
    // it, since callers of the typed API never need to read it back.
    assert.equal((summary as BatchSummary & { workers: number }).workers, 2);
    assert.equal(summary.jobs.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
