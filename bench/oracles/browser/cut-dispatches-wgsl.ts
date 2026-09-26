// The descent kernel from BEFORE the "persistent selection" batch, and the shipped cut shader
// with it in place (`DAG_SELECTION_SHADER_AVANT`), split out of `cut-dispatches.ts` to keep it
// under the file line budget. See that file for the oracle's buffers and encoding.
import { DAG_SELECTION_SHADER } from '../../../packages/sdk-browser/src/gpu/dag/shader/shader.ts';
import { DAG_LEVEL_WGSL } from '../../../packages/sdk-browser/src/gpu/dag/shader/levelWgsl.ts';

const DAG_LEVEL_WGSL_AVANT = `fn queueBase(q:u32)->u32{return select(0u,uni.nodeCount+uni.clusterCount*4u,q==1u);}
fn candBase()->u32{return uni.nodeCount+uni.clusterCount*3u;}
fn queueCounter(q:u32)->u32{return liveCounter()+2u+q*2u;}
fn queueGroups(q:u32)->u32{return queueCounter(q)+1u;}
fn candCounter()->u32{return liveCounter()+6u;}
fn candGroups()->u32{return candCounter()+1u;}
fn drawnCounter()->u32{return liveCounter()+8u;}
fn drawnGroups()->u32{return drawnCounter()+1u;}
/** Index of the primitive's root node, deposited once and for all behind its stretch. */
fn rootOf(w:u32)->u32{return bitcast<u32>(frames[w*FRAME+6u].y);}
/** A range append: the group count follows the opening of each sixty-four slice,
 *  so it is exactly \`ceil(total/64)\` without a single-thread kernel pulling it afterwards. */
fn spanAppend(counter:u32,groups:u32,base:u32,first:u32,count:u32){
 let at=atomicAdd(&work[counter],count);
 for(var k=0u;k<count;k++){
  flags[base+at+k]=first+k;
  if(((at+k)&63u)==0u){atomicAdd(&work[groups],1u);}
 }
}
fn drawnAppend(page:u32){spanAppend(drawnCounter(),drawnGroups(),candBase(),page,1u);}
/** Frame counters, reset by a single thread. Queue 0 already counts its roots: one
 *  thread per primitive has just deposited its own, at its own rank, with no counter to dispute. */
fn resetCounters(){
 atomicStore(&work[liveCounter()],0u);atomicStore(&work[liveGroups()],0u);
 atomicStore(&work[queueCounter(0u)],uni.worldCount);atomicStore(&work[queueGroups(0u)],(uni.worldCount+63u)/64u);
 atomicStore(&work[queueCounter(1u)],0u);atomicStore(&work[queueGroups(1u)],0u);
 atomicStore(&work[candCounter()],0u);atomicStore(&work[candGroups()],0u);
 atomicStore(&work[drawnCounter()],0u);atomicStore(&work[drawnGroups()],0u);
}
/** Drawn pages of the previous frame, reset by range: the only pages whose draw flag
 *  can be one. No other is visited, and none is walked in full. */
@compute @workgroup_size(64)
fn dagClearDrawn(@builtin(global_invocation_id) id:vec3u){
 let s=id.x;if(s>=atomicLoad(&work[drawnCounter()])){return;}
 flags[uni.nodeCount+flags[candBase()+s]]=0u;
}
/** A node of queue \`src\`: rejected, it yields nothing; kept, it deposits its children in the
 *  opposite queue, or its pages in the candidate list when it is a leaf. */
fn levelStep(src:u32,s:u32){
 if(s>=atomicLoad(&work[queueCounter(src)])){return;}
 let i=flags[queueBase(src)+s];
 if(i==0xffffffffu){return;}
 let node=nodes[i];
 if(outsideFrustum(node.worldIndex*FRAME,node.minimum,node.maximum)){atomicAdd(&out.frustumRejected,1u);return;}
 if(node.maxParentError>=0.0){
  let e=uni.view*worlds[node.worldIndex];
  if(projected(node.maxParentError,node.sphere,e,stretchOf(node.worldIndex),focalPixels())<=uni.pixelError){atomicAdd(&out.frustumRejected,1u);return;}
 }
 if(node.childCount>0u){spanAppend(queueCounter(1u-src),queueGroups(1u-src),queueBase(1u-src),node.firstChild,node.childCount);return;}
 spanAppend(candCounter(),candGroups(),candBase(),node.firstPage,node.pageCount);
}
@compute @workgroup_size(64)
fn dagLevel0(@builtin(global_invocation_id) id:vec3u){levelStep(0u,id.x);}
@compute @workgroup_size(64)
fn dagLevel1(@builtin(global_invocation_id) id:vec3u){levelStep(1u,id.x);}
`;

/** A function of the shipped descent, verbatim: from its `fn` to the next doc, `fn` or stage. */
function shippedFn(name: string) {
  const found = new RegExp(`^fn ${name}\\(.*?(?=\\n(?:/\\*\\*|fn |@))`, 'ms').exec(DAG_LEVEL_WGSL);
  if (!found) throw new Error(`levelWgsl.ts no longer defines ${name}`);
  return found[0];
}

/** Names the shipped shader's other stages call since (`dagPrepare`, `aheadWgsl.ts`), which the
 *  frozen `levelStep` never reaches: `markOf` and `tooCoarse` taken from the shipped descent,
 *  `descend` rewritten, since the shipped one appends to queues this layout does not have. */
const AVANT_SHIMS = `${shippedFn('markOf')}
${shippedFn('tooCoarse')}
fn descend(src:u32,node:CullNode){
 if(node.childCount>0u){spanAppend(queueCounter(1u-src),queueGroups(1u-src),queueBase(1u-src),node.firstChild,node.childCount);return;}
 spanAppend(candCounter(),candGroups(),candBase(),node.firstPage,node.pageCount);
}
`;

/** The shipped cut shader with this descent in place of its own: the module the oracle compiles.
 *  The frozen descent reads the camera's block under its old name; the shipped shader binds one
 *  block per view, and a camera is view 0 (`viewsWgsl.ts`). */
export const DAG_SELECTION_SHADER_AVANT = DAG_SELECTION_SHADER.replace(
  DAG_LEVEL_WGSL,
  DAG_LEVEL_WGSL_AVANT.replaceAll('uni.', 'views[0u].') + AVANT_SHIMS,
);
