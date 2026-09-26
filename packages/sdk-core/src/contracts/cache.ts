import {
  CLUSTERED_BLEND_FORMAT_VERSION,
  DAG_ERROR_MODEL,
  FORMAT_VERSION,
  type AssetScope,
} from './base.ts';
import { UNSPLIT_PASS, primitiveIsDrawable, type ClusterManifest } from './geometry.ts';

/**
 * The error the engine throws: a stable `code` a page can test, words for a person, and details.
 * @errorCodes Every code it may carry is in `ENGINE_ERROR_CODES` (`errorCodes.ts`).
 */
export class EngineError extends Error {
  /** Which error it is, in capitals: the word a page tests. */
  readonly code: string;
  /** Facts about the error: the file, the value, the limit. */
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}
/** Where a model's pages are read from, by key. */
export interface PageSource {
  /** Reads the bytes of one page. */
  read(key: string, signal?: AbortSignal): Promise<Uint8Array>;
}
/** Refuses a cache format this runtime does not read. */
export function assertFormat(formatVersion: number) {
  if (formatVersion !== FORMAT_VERSION && formatVersion !== CLUSTERED_BLEND_FORMAT_VERSION)
    throw new EngineError(
      'UNSUPPORTED_FORMAT',
      `Expected cache format ${FORMAT_VERSION} or ${CLUSTERED_BLEND_FORMAT_VERSION}, received ${formatVersion}`,
      { formatVersion },
    );
}

/**
 * What a host can check on a preparation pointer, before it knows anything about clusters: the
 * preparation is finished, it carries the scope that was asked for, and its format is one this SDK
 * reads. Returns the cache manifest URL the pointer names, to be resolved against the pointer URL.
 * A host has no business reading these fields itself; this is the check the reader runs.
 */
export function assertCachePointer(pointer: unknown, scope: AssetScope): string {
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer))
    throw new EngineError('INVALID_POINTER', 'preparation pointer is not a JSON object', {});
  const value = pointer as Record<string, unknown>;
  if (typeof value.status !== 'string' || typeof value.url !== 'string' || !value.url)
    throw new EngineError('INVALID_POINTER', 'preparation pointer carries no valid status/url', {
      status: value.status ?? null,
      url: value.url ?? null,
    });
  if (value.status !== 'ready')
    throw new EngineError('CACHE_NOT_READY', 'The preparation pointer is not ready', {
      status: value.status,
    });
  if (value.scope !== undefined && value.scope !== scope)
    throw new EngineError('SCOPE_MISMATCH', `Requested ${scope}, pointer contains ${value.scope}`, {
      requestedScope: scope,
      pointerScope: value.scope,
    });
  if (value.formatVersion !== undefined) assertFormat(value.formatVersion as number);
  return value.url;
}
/** What a host checks on the root `clusters.json` before any page: the cache is ready, of the
 *  requested scope, in a format this SDK reads. */
export function assertCacheRoot(root: unknown, scope: AssetScope): void {
  if (!root || typeof root !== 'object' || Array.isArray(root))
    throw new EngineError('INVALID_CACHE', 'cache manifest is not a JSON object', {});
  const value = root as Record<string, unknown>;
  // The number first: an earlier format is refused by it, never by a field it wrote otherwise.
  const formatVersion = (value.formatVersion ?? value.schema) as number;
  assertFormat(formatVersion);
  if (value.schema !== formatVersion)
    throw new EngineError('UNSUPPORTED_FORMAT', 'Cache schema and formatVersion differ', {
      schema: value.schema,
      formatVersion,
    });
  if (value.status !== 'ready')
    throw new EngineError('INVALID_CACHE', 'Unsupported Trillion3D cache', {
      status: value.status ?? null,
    });
  if (value.scope !== scope)
    throw new EngineError('SCOPE_MISMATCH', `Requested ${scope}, cache contains ${value.scope}`, {
      requestedScope: scope,
      cacheScope: value.scope,
    });
}
/** The manifest read through its pages: its root (`assertCacheRoot`) and selected geometry.
 *  Returns that triangle count; the clusters' identity is `assertCacheIdentity`'s. */
export function assertCacheReady(metadata: unknown, scope: AssetScope): number {
  assertCacheRoot(metadata, scope);
  const value = metadata as Record<string, unknown>;
  if (
    !Array.isArray(value.primitives) ||
    !Number.isSafeInteger(value.selectedNodes) ||
    typeof value.selectedTriangles !== 'number' ||
    !Number.isFinite(value.selectedTriangles)
  )
    throw new EngineError('INVALID_CACHE', 'invalid cache schema', {});
  // The one identity statement a slim manifest can make on its own: a DAG cache names the model its
  // clusters were certified with. Older caches name neither and stay readable.
  if (value.clusterStrategy === 'dag-groups' && value.errorModel !== DAG_ERROR_MODEL)
    throw new EngineError(
      'STALE_CACHE',
      `Cache error model ${value.errorModel ?? 'absent'} cannot be used; recompile with ${DAG_ERROR_MODEL}`,
      { errorModel: value.errorModel ?? null, expected: DAG_ERROR_MODEL },
    );
  return value.selectedTriangles;
}
/**
 * Rejects any cache this runtime cannot draw. The runtime reads one geometry model: a DAG of
 * clusters where every cluster carries its own screen-error band, or a whole mesh the compiler kept
 * outside the DAG (`shared-blend`), which carries no cluster at all. A cache whose clusters carry no
 * band — the old page tree — is refused by name here rather than half-read later.
 */
export function assertCacheIdentity(metadata: ClusterManifest) {
  // A manifest with a binary sidecar describes its clusters in columns; identity is a property of
  // the decoded pages, so decoding comes first and strips the pointer.
  if ((metadata as unknown as { binary?: unknown }).binary)
    throw new EngineError(
      'INVALID_CACHE',
      'A manifest with a binary sidecar must be decoded before its identity is checked',
      {},
    );
  const formatVersion = metadata.formatVersion ?? metadata.schema;
  assertFormat(formatVersion);
  if (metadata.schema !== formatVersion)
    throw new EngineError('UNSUPPORTED_FORMAT', 'Cache schema and formatVersion differ', {
      schema: metadata.schema,
      formatVersion,
    });
  if (
    formatVersion !== CLUSTERED_BLEND_FORMAT_VERSION &&
    metadata.primitives.some((primitive) => primitive.pass === 'clustered-blend')
  )
    throw new EngineError('UNSUPPORTED_FORMAT', 'clustered-blend requires cache format 2', {
      formatVersion,
    });
  const missing = metadata.primitives.findIndex((primitive) => !primitiveIsDrawable(primitive));
  if (missing >= 0) {
    const primitive = metadata.primitives[missing];
    const cause =
      primitive.pass === UNSPLIT_PASS
        ? `is ${UNSPLIT_PASS} yet carries ${primitive.pages.length} cluster pages`
        : 'has no per-cluster error band';
    throw new EngineError(
      'STALE_CACHE',
      `Cache without a cluster DAG cannot be used: primitive ${primitive.mesh}/${primitive.primitive} ${cause}; recompile with ${DAG_ERROR_MODEL}`,
      {
        mesh: primitive.mesh,
        primitive: primitive.primitive,
        pass: primitive.pass,
        errorModel: metadata.errorModel ?? null,
        expected: DAG_ERROR_MODEL,
      },
    );
  }
  if (metadata.errorModel !== DAG_ERROR_MODEL)
    throw new EngineError(
      'STALE_CACHE',
      `Cache error model ${metadata.errorModel ?? 'absent'} cannot be used; recompile with ${DAG_ERROR_MODEL}`,
      { errorModel: metadata.errorModel ?? null, expected: DAG_ERROR_MODEL },
    );
}
