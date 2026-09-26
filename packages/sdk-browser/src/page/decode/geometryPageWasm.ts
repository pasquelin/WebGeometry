import type { DecodedGeometryPage } from './geometryPage.ts';
import { CLUSTER_HEADER_WORDS } from '../../cluster/format.ts';
import { pageAttributeNames, pageViews } from './geometryPageBlock.ts';

/**
 * Loader of the SDK WebAssembly module (`packages/page-codec-wasm`) and page decoder that uses it.
 * There is only one module, hence one instantiation and one linear memory for the whole process:
 * `prepareSdkWasm` remembers it, and the core batch kernels (`wasmArena.ts`, `../../math/batchRuntime.ts`)
 * work in that same memory.
 *
 * The module imports nothing and exports only its linear memory and its functions: the compressed
 * page is written into that memory on a word boundary, the decoder reads it there and deposits
 * one block — six words of counts, then the decoded page — whose offset it returns. The block is
 * copied out once: the copy survives `page_release` and can be transferred to another thread.
 *
 * If `WebAssembly` is missing or instantiation fails, the JavaScript decoder takes over — same
 * buffers, same refusals, only slower. It is loaded then and not before, so that this loader's
 * static graph stays the module alone.
 */

/** Refusal causes of the Rust decoder, at the index of their code. */
const CAUSES = [
  '',
  'GEOMETRY_PAGE_HEADER',
  'GEOMETRY_PAGE_VERSION',
  'GEOMETRY_PAGE_BOUNDS',
  'GEOMETRY_PAGE_INDEX',
];
/** Result block: status, vertices, indices, flags, decoded bytes, quantization error bits. */
const MOTS = 6;

/** Module exports, page decoder and batch compute together. */
export type SdkWasm = {
  memory: WebAssembly.Memory;
  page_alloc(len: number): number;
  page_free(offset: number, len: number): void;
  page_decode(offset: number, len: number, maxDecodedBytes: number): number;
  page_release(offset: number): void;
  math_contract(): number;
  math_simd(): number;
  arena_alloc(bytes: number): number;
  arena_free(offset: number, bytes: number): void;
  math_box_transform_batch(out: number, boxes: number, mats: number, n: number): void;
  math_multiply_matrix4_batch(out: number, a: number, b: number, n: number): void;
  math_hierarchy_update_batch(
    world: number,
    positions: number,
    rotations: number,
    scales: number,
    parents: number,
    n: number,
  ): void;
  /** The cut's node walk (`../cut/walkWasm.ts`): 0 walked, 1 left to the JavaScript descent. */
  cut_walk(
    nodes: number,
    nodeValues: number,
    stride: number,
    bounds: number,
    boundValues: number,
    open: number,
    openValues: number,
    lens: number,
    stack: number,
    stackLength: number,
    leaves: number,
    leafCapacity: number,
    result: number,
  ): number;
  /** The normal cone of the run-time cut's clusters (`../../world/page/cutCones.ts`): 0 written,
   *  1 refused. */
  cone_clusters(
    positions: number,
    positionValues: number,
    indices: number,
    indexValues: number,
    ranges: number,
    clusters: number,
    out: number,
  ): number;
};
type SourceWasm = BufferSource | (() => Promise<BufferSource>);

let attente: Promise<SdkWasm | null> | null = null;

/** Resource shipped next to the module: the browser takes it by URL, not from disk. */
async function ressource(): Promise<BufferSource> {
  const reponse = await fetch(new URL('./pageCodec.wasm', import.meta.url));
  if (!reponse.ok) throw new Error('GEOMETRY_PAGE_WASM');
  return await reponse.arrayBuffer();
}

async function instancie(source: SourceWasm): Promise<SdkWasm | null> {
  try {
    if (typeof WebAssembly === 'undefined') return null;
    const octets = typeof source === 'function' ? await source() : source;
    const { instance } = await WebAssembly.instantiate(octets, {});
    return instance.exports as unknown as SdkWasm;
  } catch {
    return null;
  }
}

/**
 * Instantiates the module once and for all and says whether it is available. The host may supply
 * the bytes — that is what Node does, which cannot follow a file URL with `fetch`.
 */
export function prepareSdkWasm(source: SourceWasm = ressource): Promise<SdkWasm | null> {
  attente ??= instancie(source);
  return attente;
}

/** The decoded page, copied out of linear memory whole before it moves, and read as the
 *  JavaScript decoder lays it out: the indices, then each present attribute's floats. */
function copie(codec: SdkWasm, bloc: number): DecodedGeometryPage {
  const mots = new Uint32Array(codec.memory.buffer, bloc, MOTS);
  if (mots[0]) throw new Error(CAUSES[mots[0]] ?? 'GEOMETRY_PAGE_BOUNDS');
  const vertexCount = mots[1],
    flags = mots[3],
    decodedBytes = mots[4],
    quantizationError = new Float32Array(codec.memory.buffer, bloc + 20, 1)[0];
  const block = codec.memory.buffer.slice(bloc + MOTS * 4, bloc + MOTS * 4 + decodedBytes);
  return {
    ...pageViews(block, pageAttributeNames(flags), vertexCount),
    vertexCount,
    flags,
    decodedBytes,
    quantizationError,
  };
}

/** Same signature, same buffers and same refusals as `decodeGeometryPage`. */
export async function decodeGeometryPageWasm(
  data: Uint8Array,
  maxDecodedBytes = 16 * 1024 * 1024,
): Promise<DecodedGeometryPage> {
  const codec = await prepareSdkWasm();
  if (!codec) {
    const { decodeGeometryPage } = await import('./geometryPage.ts');
    return decodeGeometryPage(data, maxDecodedBytes);
  }
  if (data.byteLength < CLUSTER_HEADER_WORDS * 4) throw new Error('GEOMETRY_PAGE_HEADER');
  const inputPtr = codec.page_alloc(data.byteLength);
  if (!inputPtr) throw new Error('GEOMETRY_PAGE_BOUNDS');
  new Uint8Array(codec.memory.buffer, inputPtr, data.byteLength).set(data);
  let bloc: number;
  try {
    bloc = codec.page_decode(inputPtr, data.byteLength, maxDecodedBytes);
  } finally {
    codec.page_free(inputPtr, data.byteLength);
  }
  if (!bloc) throw new Error('GEOMETRY_PAGE_BOUNDS');
  try {
    return copie(codec, bloc);
  } finally {
    codec.page_release(bloc);
  }
}
