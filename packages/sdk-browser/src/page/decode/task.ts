import { PAGE_DECODE_PROTOCOL, pageDecodeFailureCode } from '../../../../sdk-core/src/index.ts';
import type { DecodedGeometryPage } from './geometryPage.ts';
import { pageViews } from './geometryPageBlock.ts';
import { sha256Hex } from '../../measurement/sha256Hex.ts';
import type {
  PageDecodeAnswer,
  PageDecodeGeometryPayload,
  PageDecodeRequest,
} from '../../../../sdk-core/src/index.ts';

/**
 * The page decoder, chosen once and kept. First the module compiled to WebAssembly: it names no
 * dependency, so a dedicated worker loads it even at a host that serves its modules as-is,
 * without an import map or a bundler. If it does not instantiate — no `WebAssembly`, no SIMD,
 * missing resource — the JavaScript decoder takes its place, and if that one cannot load either,
 * the task says so and the caller does the work again on its side.
 *
 * Both yield the same buffers and the same refusals: the H2b bench proves it value by value.
 */
type Decodeur = {
  decode: (data: Uint8Array, maxDecodedBytes: number) => Promise<DecodedGeometryPage>;
  wasm: boolean;
};
let decodeur: Promise<Decodeur> | undefined;

async function chargeDecodeur(): Promise<Decodeur> {
  const codec = await import('./geometryPageWasm.ts');
  if (await codec.prepareSdkWasm()) return { decode: codec.decodeGeometryPageWasm, wasm: true };
  const js = await import('./geometryPage.ts');
  return { decode: async (data, max) => js.decodeGeometryPage(data, max), wasm: false };
}

/** No decoder on this side of the thread: the caller will redo the work on its side, rejecting nothing. */
function indisponible(id: number, cause: unknown) {
  return {
    answer: {
      protocol: PAGE_DECODE_PROTOCOL,
      id,
      ok: false as const,
      code: 'PAGE_DECODE_UNAVAILABLE' as const,
      message: cause instanceof Error ? cause.message : String(cause),
    },
    transfer: [] as ArrayBuffer[],
  };
}

/**
 * The work itself, written once. The worker runs it, and the synchronous fallback runs exactly
 * the same function on the main thread: that sharing — and not a re-read of both codes — is what
 * guarantees the same output byte on both sides of the thread.
 */
export async function runPageDecodeTask(
  request: PageDecodeRequest,
): Promise<{ answer: PageDecodeAnswer; transfer: ArrayBuffer[] }> {
  const started = performance.now();
  try {
    if (request.op === 'cut') {
      // Loaded on the first cut alone: a worker that only decodes never reads the encoder.
      const cutter = await import('../../world/page/runtimeCut.ts');
      const { drawn, cones } = cutter.unpackDrawn(request.source);
      const cut = await cutter.cutDrawnTriangles(drawn, cones);
      return {
        answer: {
          protocol: PAGE_DECODE_PROTOCOL,
          id: request.id,
          ok: true,
          sha256: null,
          source: null,
          decoded: null,
          cut,
          wasm: false,
          taskMs: performance.now() - started,
        },
        transfer: cut.pages.flatMap((page) => [page.index, page.geometry]),
      };
    }
    if (request.op === 'verify') {
      const sha256 = await sha256Hex(request.source);
      return {
        answer: {
          protocol: PAGE_DECODE_PROTOCOL,
          id: request.id,
          ok: true,
          sha256,
          source: request.source,
          decoded: null,
          wasm: false,
          taskMs: performance.now() - started,
        },
        transfer: [request.source],
      };
    }
    let choisi: Decodeur;
    try {
      choisi = await (decodeur ??= chargeDecodeur());
    } catch (cause) {
      decodeur = undefined;
      return indisponible(request.id, cause);
    }
    const decoded = await choisi.decode(new Uint8Array(request.source), request.maxDecodedBytes);
    const payload = geometryPayload(decoded);
    return {
      answer: {
        protocol: PAGE_DECODE_PROTOCOL,
        id: request.id,
        ok: true,
        sha256: null,
        source: null,
        decoded: payload,
        wasm: choisi.wasm,
        taskMs: performance.now() - started,
      },
      transfer: [payload.block],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      answer: {
        protocol: PAGE_DECODE_PROTOCOL,
        id: request.id,
        ok: false,
        code: pageDecodeFailureCode(message),
        message,
      },
      transfer: [],
    };
  }
}

/**
 * The decoded page, ready to be transferred: its indices and attributes are views on one block
 * that owns its buffer whole, so `block` is exactly the page, and the transfer loses nothing
 * and copies nothing.
 */
function geometryPayload(page: DecodedGeometryPage): PageDecodeGeometryPayload {
  return {
    block: page.indices.buffer,
    names: Object.keys(page.attributes),
    vertexCount: page.vertexCount,
    flags: page.flags,
    decodedBytes: page.decodedBytes,
    quantizationError: page.quantizationError,
  };
}

/** The decoded page rebuilt on its block. `names` yields the decode's write order, so the
 *  attribute `Record` finds its fields in the same order as an in-place decode. */
export function restorePageDecode(payload: PageDecodeGeometryPayload): DecodedGeometryPage {
  return {
    ...pageViews(payload.block, payload.names, payload.vertexCount),
    vertexCount: payload.vertexCount,
    flags: payload.flags,
    decodedBytes: payload.decodedBytes,
    quantizationError: payload.quantizationError,
  };
}
