import { REQUEST_PRIORITY_MAX } from '../request.ts';

/**
 * SNAPSHOT write: what the GPU reports to the CPU, and the ceiling that bounds it.
 *
 * The snapshot is the only thing a frame brings back down from the GPU. The draw mask stays
 * in place — compute raster reads it where `dagMask` put it —, so what passes here never
 * serves to draw: it serves to BROADCAST. From it the host takes the pages it must load, pin
 * or return to the cache.
 *
 * Each rank is a REQUEST: the page and the priority the host will give it in its upload queue,
 * in a single word (`../request.ts`).
 *
 * The ceiling (`SELECTION_LIST_CAP`, `../layout.ts`) bounds what the frame copy takes. A
 * refused rank sets bit 0: the snapshot is then TRUNCATED, and the frame refuses it whole
 * rather than adopt it amputated. Frame totals lose nothing — they describe the cut, not the
 * list that reports it (`totalsWgsl.ts`).
 *
 * The camera's requests are STAGED behind the drawn list, where the frame copy never reads, in
 * the order the threads won the counter; `dagSortRequests` then writes them into the snapshot by
 * `requestRank`, highest first. The host reads them in that order and ranks nothing. A light cut
 * writes its own list straight into its snapshot (`../lightCutReports.ts`).
 */
export const DAG_RELEVE_WGSL = `fn emitOne(page:u32,pixels:f32){emitWord(page,quantizePriority(pixels),true);}
/** Where the camera's request \`s\` waits for the sort: behind the drawn list and its header
 *  (\`stagedRequestsWord\`, \`../layout.ts\`, counted from \`out\`'s first word). */
fn stagedAt(s:u32)->u32{return 2u*views[0u].listCap+HEAD+s;}
/** One request word in the sample; past the cap it is dropped, and \`declare\` says truncated. */
fn emitWord(page:u32,priority:u32,declare:bool){
 let slot=atomicAdd(&out.count,1u);
 if(slot>=views[0u].listCap){if(declare){atomicOr(&out.overflow,1u);}return;}
 out.pages[select(stagedAt(slot),slot,isLightCut())]=packRequest(page,priority);
}
/** A request of the view ahead (\`aheadWgsl.ts\`): the lower tier, and never more than half the
 *  cap, so the camera's own requests keep the other half. Past it the request is dropped, never
 *  declared: the sample stays whole for the camera, which alone decides truncation. */
fn emitAhead(page:u32,pixels:f32){
 if(!aheadFull()){emitWord(page,REQUEST_AHEAD|quantizePriority(pixels),false);}
}
/** True once the sample holds half its cap: the view ahead asks for nothing more this frame. */
fn aheadFull()->bool{return atomicLoad(&out.count)>=views[0u].listCap/2u;}
const RANKS:u32=${REQUEST_PRIORITY_MAX + 1}u;
const SORT_LANES:u32=256u;
var<workgroup> rankPlace:array<atomic<u32>,RANKS>;
/** Counting sort of the staged requests into the snapshot, one workgroup: count each rank, give
 *  each rank its first place from the highest down, then scatter. Within a rank the order is the
 *  threads', as it was the counter's: the rank alone orders, as on the reference. */
@compute @workgroup_size(SORT_LANES)
fn dagSortRequests(@builtin(local_invocation_index) lane:u32){
 let n=min(atomicLoad(&out.count),views[0u].listCap);
 for(var r=lane;r<RANKS;r+=SORT_LANES){atomicStore(&rankPlace[r],0u);}
 workgroupBarrier();
 for(var s=lane;s<n;s+=SORT_LANES){atomicAdd(&rankPlace[requestWordRank(out.pages[stagedAt(s)])],1u);}
 workgroupBarrier();
 if(lane==0u){
  var place=0u;
  for(var r=RANKS;r>0u;r--){let held=atomicLoad(&rankPlace[r-1u]);atomicStore(&rankPlace[r-1u],place);place+=held;}
 }
 workgroupBarrier();
 for(var s=lane;s<n;s+=SORT_LANES){let word=out.pages[stagedAt(s)];out.pages[atomicAdd(&rankPlace[requestWordRank(word)],1u)]=word;}
}
`;
