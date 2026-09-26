import type { Page } from '../contracts/geometry.ts';

/**
 * Off-main-thread page-decode contract, version 6: the decoded geometry travels as one block
 * with its quantization error, and the arena slot records that error in word 8; `cut` turns
 * drawn triangles into pages, which come back as bytes with their descriptors and, since
 * version 6, their normal cone, the packed triangles carrying whether their pages keep one.
 *
 * The calling thread sends a `PageDecodeRequest`, the executor returns a `PageDecodeAnswer` carrying
 * the same `id`. Nothing here touches the platform: no `Worker`, no fetch, no clock — the browser
 * adapter carries all of that, this file only carries the message shape, the closed list of
 * failures and the pool bound.
 *
 * Buffer ownership: `source` is **transferred** with the request, so the sender no longer owns
 * it. A `verify` response returns it, transferred in turn; a `decode` response returns the decoded
 * buffers instead, also transferred. An executor that transfers nothing (the synchronous fallback)
 * returns exactly the same values: the contract does not say how the work travels, only what it
 * returns.
 */
export const PAGE_DECODE_PROTOCOL = 6;

/** `verify`: a page's SHA-256 digest. `decode`: its indices and per-vertex attributes. `cut`:
 *  drawn triangles, packed as five lengths, whether their pages keep a cone, then five four-byte
 *  arrays (`packDrawn`), cut into pages. */
export type PageDecodeOp = 'verify' | 'decode' | 'cut';

/** One page a `cut` wrote: its index and geometry bytes, their digests, and its descriptor. */
export interface PageCutPage {
  /** The triangle indices. */ index: ArrayBuffer;
  /** The vertex bytes. */ geometry: ArrayBuffer;
  /** Fingerprint of the indices. */ indexSha256: string;
  /** Fingerprint of the vertices. */ geometrySha256: string;
  /** Triangles in the page. */ count: number;
  /** Its first source triangle. */ start: number;
  /** Lowest corner. */ min: number[];
  /** Highest corner. */ max: number[];
  /** Bounding ball. */ sphere: number[];
  /** Vertices in the page. */ vertexCount: number;
  /** Indices in the page. */ indexCount: number;
  /** Which attributes it carries. */ flags: number;
  /** Its size once unpacked. */ uncompressedBytes: number;
  /** The cone of its triangles' normals, when one was built. */
  cone?: Page['cone'];
}
/** What a `cut` returns: its pages, and the grids they were quantized on. */
export interface PageCutPayload {
  /** The pages written. */ pages: PageCutPage[];
  /** Grid step of positions, as a power of two. */ positionExponent: number;
  /** Grid step of texture coordinates, as a power of two. */ uvExponent: number;
  /** Largest position error on that grid. */ maxPositionError: number;
}

/** A message asking a worker to check, unpack or cut a page. */
export interface PageDecodeRequest {
  /** Message format version. */ protocol: number;
  /** Request number. */ id: number;
  /** What to do. */ op: PageDecodeOp;
  /** Transferred with the message: the sender is no longer the owner. */
  source: ArrayBuffer;
  /** Ceiling of decoded bytes of a geometry page; ignored by `verify`. */
  maxDecodedBytes: number;
}

/**
 * A worker's shared-memory lease: the arena buffer, the slot and the region it
 * owns, and the slot count, which gives the size of the control zone. Posted once,
 * at worker birth, and only where the platform allows shared memory.
 * Without a lease, the worker answers by transferring buffers: the contract does not change shape,
 * only the byte path does.
 */
export interface PageDecodeShare {
  /** Message format version. */ protocol: number;
  /** Always 0. */ id: 0;
  /** Always `'share'`. */ op: 'share';
  /** The shared memory. */ buffer: SharedArrayBuffer;
  /** This worker's slot. */ slot: number;
  /** Slots in all. */ slots: number;
}

/** Cancellation of a request still in the queue. Work already started runs to completion then answers
 *  `PAGE_DECODE_CANCELLED`: the executor has no interrupt point in the middle of a decode. */
export interface PageDecodeCancel {
  /** Message format version. */ protocol: number;
  /** The request to cancel. */ id: number;
  /** Always `'cancel'`. */ op: 'cancel';
}

/** A decoded page as one buffer of `decodedBytes`: the 32-bit indices, then the floats of each
 *  attribute `names` lists, in the decode write order — that order is what yields a
 *  field-for-field identical `Record`. */
export interface PageDecodeGeometryPayload {
  /** Indices, then attributes. */ block: ArrayBuffer;
  /** The attributes, in order. */ names: string[];
  /** Vertices. */ vertexCount: number;
  /** Which attributes it carries. */ flags: number;
  /** Size of `block`. */ decodedBytes: number;
  /** The page header's largest position displacement, in object units. */
  quantizationError: number;
}

/** A worker's answer when a page request succeeded. */ export interface PageDecodeDone {
  /** Message format version. */ protocol: number;
  /** The request answered. */ id: number;
  /** Always `true`. */ ok: true;
  /** `verify`: the lowercase hexadecimal digest. `decode`: `null`. */
  sha256: string | null;
  /** `verify`: the source buffer returned. `decode`: `null`, the source is consumed. */
  source: ArrayBuffer | null;
  /** `decode`: the unpacked page. */ decoded: PageDecodeGeometryPayload | null;
  /** `cut`: the pages, their bytes transferred. Absent otherwise. */
  cut?: PageCutPayload;
  /** True when the WebAssembly-compiled decoder did the work, false for the
   *  JavaScript decoder. Both yield the same bytes; only the counter distinguishes them. */
  wasm: boolean;
  /** Task time, measured by the executor itself. */
  taskMs: number;
}

/**
 * Failure semantics, closed list. The first six are the page-decode rejections, taken word
 * for word from `geometryPage.ts`: a caller distinguishes them as before. `PAGE_DECODE_FAILED` carries
 * any other rejection from the decompression library. `PAGE_DECODE_CANCELLED` answers a
 * cancellation, `PAGE_DECODE_WORKER` an executor that vanished — only that one allows the fallback.
 */
export const PAGE_DECODE_FAILURES = [
  'GEOMETRY_PAGE_HEADER',
  'GEOMETRY_PAGE_VERSION',
  'GEOMETRY_PAGE_BOUNDS',
  'GEOMETRY_PAGE_INDEX',
  'GEOMETRY_PAGE_NONFINITE',
  'PAGE_DECODE_FAILED',
  'PAGE_DECODE_CANCELLED',
  'PAGE_DECODE_UNAVAILABLE',
  'PAGE_DECODE_WORKER',
] as const;
/** The name of a way a page request can fail. */
export type PageDecodeFailureCode = (typeof PAGE_DECODE_FAILURES)[number];

/** A worker's answer when a page request failed. */ export interface PageDecodeFailed {
  /** Message format version. */ protocol: number;
  /** The request answered. */ id: number;
  /** Always `false`. */ ok: false;
  /** Why it failed. */ code: PageDecodeFailureCode;
  /** The original message, as-is: the caller raises the same `Error` as the synchronous path. */
  message: string;
}
/** A worker's answer to a page request: done or failed. */
export type PageDecodeAnswer = PageDecodeDone | PageDecodeFailed;

/** The named rejection that matches a message, or `PAGE_DECODE_FAILED` for everything else. */
export function pageDecodeFailureCode(message: string): PageDecodeFailureCode {
  for (const code of PAGE_DECODE_FAILURES) if (code === message) return code;
  return 'PAGE_DECODE_FAILED';
}

/**
 * Size of the decode pool: never more than the cores the machine reports, never more than
 * the package ceiling, never more than the admission bound already in force on transfers, and
 * at least one. A missing or non-integer value equals a single executor: on a platform that
 * reports nothing, we do not invent parallelism.
 */
export function pageDecodeWorkerCount(
  hardwareConcurrency: number | undefined,
  admissionLimit: number,
  ceiling = 4,
) {
  const cores = Number.isSafeInteger(hardwareConcurrency) ? (hardwareConcurrency as number) : 1;
  const admission = Number.isSafeInteger(admissionLimit) ? admissionLimit : 1;
  return Math.max(1, Math.min(cores, ceiling, admission));
}
