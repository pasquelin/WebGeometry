/**
 * The BROADCAST REQUEST: what a frame brings back down from the GPU so the host knows what to
 * load, and in which order.
 *
 * The cut ordered its ranks by an atomic counter, hence by nothing: the host uploaded in the
 * order the threads had won the race. The WebGL2 path has always ranked by the REPLACEMENT'S
 * SCREEN ERROR (`../../streaming/priority.ts`, `orderPendingUrls`) — a missing cluster is drawn by a
 * coarser ancestor, and that ancestor's error is exactly what the eye sees: it is what decides
 * who arrives first. The GPU now carries the same value, computed by the same formula
 * (`projected`, proven mirror of `clusterErrorPixels`).
 *
 * One WORD per request, so the frame copy stays what it is: the page in the low 22 bits —
 * 4,194,304 clusters, against 1,959,792 on the largest measured scene —, the priority in the high
 * 10. The priority's top bit says the request comes from the view AHEAD of the camera
 * (`shader/aheadWgsl.ts`); the nine bits below are the replacement's error, quantized
 * LOGARITHMICALLY and monotone: it only ranks, and a constant relative step keeps as much precision
 * on a one-pixel error as on a thousand-pixel one. Two neighbouring errors may fall in the same
 * step — order between them is then indifferent, as it is on the reference, which does not break
 * ties either.
 *
 * The RANK the GPU sorts by (`requestRank`, `shader/snapshotWgsl.ts`) puts every visible request
 * before every request ahead — the deadline of the first is now, of the second the horizon —, then
 * the larger error first. The host reads the requests in that order and ranks nothing.
 */
const REQUEST_PAGE_BITS = 22;
export const REQUEST_PAGE_MAX = 1 << REQUEST_PAGE_BITS;
/** The whole priority field: the ten bits above the page. */
export const REQUEST_PRIORITY_MAX = (1 << (32 - REQUEST_PAGE_BITS)) - 1;
/** The priority bit of a request ahead of the camera: the field's top bit. */
export const REQUEST_AHEAD = (REQUEST_PRIORITY_MAX + 1) >> 1;
/** The highest error step of either tier. */
export const REQUEST_STEP_MAX = REQUEST_AHEAD - 1;
/** Quantization step: sixteen steps per error doubling, as before the tier bit, over thirty-two
 *  doublings — four billion pixels, past any finite error a screen projects; the near plane
 *  reached is `Infinity`, the tier's highest step. */
export const REQUEST_PRIORITY_SCALE = 16;

/** Priority of an error in pixels, monotone increasing and bounded within its tier. `Infinity`
 *  takes the tier's highest step: a cluster nothing replaces is what is missing most. */
export function quantizeRequestPriority(pixels: number, ahead = false) {
  const tier = ahead ? REQUEST_AHEAD : 0;
  if (!(pixels > 0)) return tier;
  if (!Number.isFinite(pixels)) return tier | REQUEST_STEP_MAX;
  const pas = Math.round(Math.log2(1 + pixels) * REQUEST_PRIORITY_SCALE);
  return tier | Math.min(REQUEST_STEP_MAX, Math.max(0, pas));
}
/** The order a priority is served in, highest first: the visible tier above the tier ahead. */
export const requestRank = (priority: number) => priority ^ REQUEST_AHEAD;

export const packRequest = (page: number, priority: number) =>
  ((priority << REQUEST_PAGE_BITS) | page) >>> 0;
export const requestPage = (word: number) => word & (REQUEST_PAGE_MAX - 1);
export const requestPriority = (word: number) => word >>> REQUEST_PAGE_BITS;
/** The rank of a request word: what `dagSortRequests` orders by. */
export const requestWordRank = (word: number) => requestRank(requestPriority(word));
/** In `words[start, end)`, sorted by rank, the first request of the view ahead: every visible
 *  request comes before it. */
export function firstAheadRequest(words: ArrayLike<number>, start = 0, end = words.length) {
  let at = start;
  while (at < end && !(requestPriority(words[at]) & REQUEST_AHEAD)) at++;
  return at;
}

/**
 * CPU mirror of `dagSortRequests` (`shader/snapshotWgsl.ts`), what the oracle and the Node device
 * replay: the words by `requestRank`, highest first, in one count and one scatter over the ranks.
 * Within a rank it keeps the order the words came in, one of the orders the kernel's threads give.
 */
export function sortRequestWords(words: ArrayLike<number>) {
  const place = new Uint32Array(REQUEST_PRIORITY_MAX + 1);
  for (let i = 0; i < words.length; i++) place[requestWordRank(words[i])]++;
  for (let rank = REQUEST_PRIORITY_MAX, first = 0; rank >= 0; rank--) {
    const held = place[rank];
    place[rank] = first;
    first += held;
  }
  const sorted = new Uint32Array(words.length);
  for (let i = 0; i < words.length; i++) sorted[place[requestWordRank(words[i])]++] = words[i];
  return sorted;
}

/**
 * WGSL mirror, bit for bit. WGSL `log2` and JavaScript `Math.log2` need not return the same
 * last bit, so rounding may split two neighbouring steps: the published order remains that of
 * the errors, only the boundary between two steps is floating. That is why the proof compares
 * ORDERS and not words.
 */
export const DAG_REQUEST_WGSL = `const PAGE_BITS:u32=${REQUEST_PAGE_BITS}u;
const REQUEST_AHEAD:u32=${REQUEST_AHEAD}u;
fn quantizePriority(pixels:f32)->u32{
 if(!(pixels>0.0)){return 0u;}
 if(pixels>=INF){return ${REQUEST_STEP_MAX}u;}
 let pas=i32(round(log2(1.0+pixels)*${REQUEST_PRIORITY_SCALE}.0));
 return u32(clamp(pas,0,${REQUEST_STEP_MAX}));
}
fn packRequest(page:u32,priority:u32)->u32{return (priority<<PAGE_BITS)|page;}
fn requestWordRank(word:u32)->u32{return (word>>PAGE_BITS)^REQUEST_AHEAD;}
`;
