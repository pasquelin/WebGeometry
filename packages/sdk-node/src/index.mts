import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCompiler } from './compiler/process.mts';
export {
  COMPILER_LINE_LIMIT,
  CANCEL_GRACE_MS,
  resolveCompilerExecutable,
} from './compiler/process.mts';
export { getSdkProvenance } from './compiler/provenance.mts';
import { DEFAULT_SCOPE, readPagedManifest } from '../../sdk-core/src/index.ts';
import type { AssetScope } from '../../sdk-core/src/index.ts';
import type {
  BatchJob,
  BatchOptions,
  BatchSummary,
  CompilationJob,
  CompilationJobOptions,
  CompilationPointer,
  CompilationResult,
  PrepareOptions,
} from './compiler/contracts.ts';
export { DEFAULT_SCOPE };
export type {
  BatchJob,
  BatchOptions,
  BatchOutcome,
  BatchSummary,
  CompilationJob,
  CompilationJobOptions,
  CompilationPointer,
  CompilationResult,
  CompilationSummary,
  CompilerEvent,
  CutoutModel,
  CutoutReviewOptions,
  CutoutReviewSummary,
  PrepareOptions,
  ProgressPointer,
  ProgressStream,
  ReusedFolder,
  TerminalProgress,
  TerminalProgressOptions,
} from './compiler/contracts.ts';
export { createTerminalProgress, createBatchProgress } from './cli/progress.mts';
export { reviewCutouts } from './cutout/review.mts';
/**
 * Compiles a source model into the cache a page loads. Native is the production path: the host
 * supplies the executable explicitly or through the environment.
 * @param input - A folder with a `manifest.json` or one glTF/GLB, or a `.gltf`, `.glb`, `.fbx`, `.obj` file.
 * @param output - The cache folder; the source is never overwritten.
 * @param scope - `'slice'` streams the model in pages, `'full'` keeps it whole.
 * @param budget - How many triangles the cache may keep.
 * @param options - Where the page loads files from, and how the compiler runs.
 * @returns The manifest the compiler wrote, with what the run measured.
 */
export async function prepare(
  input: string,
  output: string,
  scope: AssetScope = DEFAULT_SCOPE,
  budget = 150000,
  options?: PrepareOptions,
): Promise<CompilationResult> {
  if (typeof options?.resourceBaseUrl !== 'string' || !options.resourceBaseUrl)
    throw new Error('resourceBaseUrl is required');
  const args = [
    input,
    output,
    scope,
    String(budget),
    String(options.threads ?? 2),
    String(options.ramBudgetMb ?? 256),
    options.resourceBaseUrl,
    options.simplification ?? 'none',
  ];
  const pointer = await runCompiler<CompilationPointer | { status: 'error'; code?: string }>(
    args,
    options,
    options.onProgress,
  );
  if (pointer.status !== 'ready') throw new Error(pointer.code ?? 'COMPILER_NOT_READY');
  const path = join(output, 'native', pointer.scope, pointer.url);
  const root = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const read = (page: { url: string }) => readFile(join(dirname(path), page.url));
  const manifest = (await readPagedManifest(root, read)) as unknown as CompilationResult;
  return {
    ...manifest,
    metrics: withFinalMetrics(manifest, pointer),
    url: pointer.url,
    pointer: pointer.pointer,
    cache: pointer.cache,
    reused: pointer.reused ?? null,
  };
}
/**
 * The manifest is serialized before the cache is pruned, so it cannot hold what comes after it —
 * the purge and the job's own duration. Those live on the pointer alone, and a caller that only
 * reads the returned result would otherwise never see them. The manifest stays authoritative for
 * every measurement it does carry: it is spread last, so it wins over the pointer, which
 * only fills in the keys it leaves out. A reused folder is another run: its manifest describes
 * the compile that wrote it, so only the pointer's numbers — this run's — are returned.
 */
function withFinalMetrics(manifest: CompilationResult, pointer: CompilationPointer) {
  if (pointer.reused) return { ...pointer.metrics };
  return { ...pointer.metrics, ...(manifest.metrics as Record<string, unknown> | undefined) };
}
/**
 * Compiles many models in one compiler process. The compiler runs `workers` jobs at a time and
 * splits `ramBudgetMb` between them.
 * @param jobs - The models to compile, at least one; each names its `resourceBaseUrl`.
 * @param options - How many jobs run at once, the memory they share, and who hears the events.
 * @returns How each job ended: pointers only, nothing read back from disk.
 */
export async function prepareMany(
  jobs: BatchJob[],
  options: BatchOptions = {},
): Promise<BatchSummary> {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('jobs must be a non-empty array');
  for (const job of jobs) {
    if (typeof job.resourceBaseUrl !== 'string' || !job.resourceBaseUrl)
      throw new Error(`job ${job.id ?? '?'}: resourceBaseUrl is required`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'trillion3d-batch-'));
  try {
    const file = join(directory, 'jobs.json');
    await writeFile(
      file,
      JSON.stringify({
        workers: options.workers ?? 1,
        ramBudgetMb: options.ramBudgetMb,
        threads: options.threads,
        jobs,
      }),
    );
    const summary = await runCompiler<BatchSummary | { status: 'error'; code?: string }>(
      ['--jobs', file],
      options,
      options.onEvent,
    );
    if (summary.status === 'error') throw new Error(summary.code ?? 'INVALID_BATCH');
    return summary;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
/** Host-visible job lifecycle; abort forwards to the native subprocess. */
export async function createCompilationJob(
  id: string,
  input: string,
  output: string,
  options: CompilationJobOptions,
): Promise<CompilationJob> {
  const { createJob } = await import('../../sdk-core/src/index.ts');
  return createJob(
    id,
    ({ signal, progress }) =>
      prepare(input, output, options.scope ?? DEFAULT_SCOPE, options.triangleBudget ?? 150000, {
        ...options,
        signal,
        onProgress: (event) => progress({ ...event, phase: event.phase ?? event.event }),
      }),
    { signal: options.signal, telemetry: options.telemetry },
  );
}
