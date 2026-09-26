// The DAG selection WGSL kernel actually run in Chromium WebGPU: buffers packed
// by `packDagSelection`, uniforms from `writeDagUniforms`, passes `dagPrepare` through `dagMask`
// then `dagSortRequests` in engine order (non-resident cut), then a readback of the GPU output.
import { DAG_SELECTION_SHADER } from '../../../packages/sdk-browser/src/gpu/dag/shader/shader.ts';
import {
  DAG_BINDING,
  dagBindEntries,
} from '../../../packages/sdk-browser/src/gpu/dag/shader/bindings.ts';
import { dansPageWebgpu } from './pageWebgpu.ts';
import { SELECTION_WORKGROUP } from '../../../packages/sdk-browser/src/gpu/core/selection.ts';
import type { SelectionUniforms } from '../../../packages/sdk-browser/src/gpu/core/selection.ts';
import { REQUEST_PAGE_MAX } from '../../../packages/sdk-browser/src/gpu/dag/request.ts';
import {
  OUT_SELECTED_TRIANGLES,
  OUT_TRANSPARENT_TRIANGLES,
  SELECTION_HEADER_WORDS,
} from '../../../packages/sdk-browser/src/gpu/dag/layout.ts';
import type { PackedDag } from '../../../packages/sdk-browser/src/gpu/dag/types.ts';
import { versPage } from './selectionKernelGpuPack.ts';
import type { ExecuterEntree, ExecutionResultat, Resultat } from './selectionKernelGpuPack.ts';

/** Run in the page: one pipeline, every case, the `Output` read back for each. */
async function executer({
  shader,
  cas,
  workgroup,
  entete,
  totaux,
  bitsPage,
  layoutEntries,
  bindings,
}: ExecuterEntree): Promise<ExecutionResultat> {
  const appareil = await globalThis.ouvrirAppareil();
  if (!appareil) return { indisponible: 'no WebGPU adapter' };
  const { device, erreurs } = appareil;
  const { module, compilation } = await appareil.compile(shader);
  if (compilation.length) return { compilation, erreurs };
  const layout = device.createBindGroupLayout({ entries: layoutEntries });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const etape = (entryPoint: string) =>
    device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint } });
  const preparePipeline = etape('dagPrepare');
  // Level descent: pass 0 starts from the roots, each following pass runs on the
  // three queues `levelStep` fills in turn (see `packages/sdk-browser/src/gpu/dag/shader/levelWgsl.ts`).
  const levelPipelines = [etape('dagLevel0'), etape('dagLevel1'), etape('dagLevel2')];
  const wantedPipeline = etape('dagWanted');
  const maskPipeline = etape('dagMask'),
    sortPipeline = etape('dagSortRequests');
  const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const tampon = (taille: number, octetsSource?: number[], usage: number = STORAGE): GPUBuffer => {
    const buffer = device.createBuffer({
      size: Math.max(taille, octetsSource?.length ?? 0),
      usage,
    });
    if (octetsSource) device.queue.writeBuffer(buffer, 0, new Uint8Array(octetsSource));
    return buffer;
  };
  const groupes = (n: number): number => Math.max(1, Math.ceil(n / workgroup));
  const resultats: Resultat[] = [];
  for (const c of cas) {
    // Requests wait behind the drawn list (`stagedRequestsWord`); the copy reads them sorted.
    const sortieOctets = entete * 4 + c.pageCount * 4,
      octetsAttente = (2 * entete + 3 * c.pageCount) * 4;
    const blockCount = groupes(c.pageCount);
    // The `work` layout is the one the engine lays down, computed on the Node side and
    // carried with the case: the page has no module to import, and the bench cannot derive another.
    const travail = c.travail;
    // Each buffer under its WGSL name: `namedBufferEntries` lays it at that name's binding.
    const buffers = {
      clusters: { buffer: tampon(64, c.clusters) },
      nodes: { buffer: tampon(64, c.nodes) },
      views: { buffer: tampon(256, c.uniforms, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST) },
      flags: { buffer: tampon(Math.max(16, c.flagsWords * 4)) },
      out: { buffer: tampon(octetsAttente) },
      work: { buffer: tampon(Math.max(8, travail.words * 4)) },
      worlds: { buffer: tampon(64, c.worlds) },
      frames: { buffer: tampon(16, c.frames) },
      cold: { buffer: tampon(48, c.pageCones) },
    };
    const lecture = device.createBuffer({
      size: sortieOctets,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    // Frame counters: what descent listed as candidates, and what `dagWanted` kept
    // live. Those two list sizes are what the five following passes reread.
    const octetsTravail = Math.max(8, travail.words * 4);
    const compteurs = device.createBuffer({
      size: octetsTravail,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    // Draw flags `dagMask` leaves behind the descent queue (`queueCap` = node count), one per page.
    const octetsDrapeaux = c.pageCount * 4;
    const drapeaux = device.createBuffer({
      size: Math.max(4, octetsDrapeaux),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const group = device.createBindGroup({
      layout,
      entries: globalThis.namedBufferEntries(bindings, buffers),
    });
    const encoder = device.createCommandEncoder();
    const tete = encoder.beginComputePass();
    tete.setBindGroup(0, group);
    tete.setPipeline(preparePipeline);
    tete.dispatchWorkgroups(groupes(Math.max(c.worldCount, blockCount)));
    // The whole descent in this pass, as the engine encodes it: launches in the same pass
    // run in order and see what the previous ones wrote. Each is dispatched flat, over
    // an upper bound on its level's node count.
    tete.setPipeline(levelPipelines[0]);
    tete.dispatchWorkgroups(groupes(c.nodeCount));
    for (let niveau = 1; niveau < c.levelCount; niveau++) {
      tete.setPipeline(levelPipelines[niveau % 3]);
      tete.dispatchWorkgroups(groupes(c.nodeCount));
    }
    tete.end();
    // Pages of the kept leaves, then their verdict: the two final passes visit at most
    // `pageCount` clusters, a safe upper bound on the candidate list and the live list.
    const fin = encoder.beginComputePass();
    fin.setBindGroup(0, group);
    fin.setPipeline(wantedPipeline);
    fin.dispatchWorkgroups(groupes(c.pageCount));
    fin.setPipeline(maskPipeline);
    fin.dispatchWorkgroups(groupes(c.pageCount));
    fin.setPipeline(sortPipeline);
    fin.dispatchWorkgroups(1);
    fin.end();
    encoder.copyBufferToBuffer(buffers.out.buffer, 0, lecture, 0, sortieOctets);
    encoder.copyBufferToBuffer(buffers.work.buffer, 0, compteurs, 0, octetsTravail);
    if (octetsDrapeaux)
      encoder.copyBufferToBuffer(
        buffers.flags.buffer,
        c.nodeCount * 4,
        drapeaux,
        0,
        octetsDrapeaux,
      );
    device.queue.submit([encoder.finish()]);
    await lecture.mapAsync(GPUMapMode.READ);
    const ints = new Uint32Array(lecture.getMappedRange().slice(0));
    lecture.unmap();
    await compteurs.mapAsync(GPUMapMode.READ);
    const compteursLus = new Uint32Array(compteurs.getMappedRange().slice(0));
    compteurs.unmap();
    await drapeaux.mapAsync(GPUMapMode.READ);
    const dessine = new Uint32Array(drapeaux.getMappedRange().slice(0));
    drapeaux.unmap();
    const count = Math.min(ints[0], c.pageCount);
    resultats.push({
      name: c.name,
      // Request words as the GPU sorted them; `pages` by page, for proofs that compare sets.
      demandes: Array.from(ints.subarray(entete, entete + count)),
      pages: Array.from(ints.subarray(entete, entete + count))
        .map((mot) => mot & (bitsPage - 1))
        .sort((a, b) => a - b),
      frustumRejected: ints[1],
      overflow: ints[3],
      // Totals the GPU holds: this is where they are compared to the oracle's.
      selectedTriangles: ints[totaux.selected],
      transparentTriangles: ints[totaux.transparent],
      dessinees: Array.from(dessine.subarray(0, c.pageCount).keys()).filter((i) => dessine[i]),
      candidates: compteursLus[travail.candCounter],
      vivantes: compteursLus[travail.liveCounter],
    });
    const tampons = Object.values(buffers).map((b) => b.buffer);
    for (const buffer of [...tampons, lecture, compteurs, drapeaux]) buffer.destroy();
  }
  const info = await appareil.fermer();
  return { adaptateur: info.court, resultats, erreurs };
}

/**
 * Run the GPU kernel on each `{ name, packed, uniforms }` and return the pages the GPU
 * selected, with the sizes of the two lists the frame rereads: descent candidates and
 * `dagWanted` live ones. `shader` replaces the kernel text to compare two versions.
 */
export async function selectionGpu(
  cas: Array<{
    name: string;
    packed: PackedDag;
    uniforms: SelectionUniforms;
    resident?: ArrayLike<number>;
  }>,
  shader = DAG_SELECTION_SHADER,
): Promise<ExecutionResultat> {
  // The function is SERIALIZED into the page: it only sees its argument. The readback
  // header layout therefore travels with it, instead of being reread from a module the page lacks.
  return await dansPageWebgpu(executer, {
    shader,
    cas: cas.map((c) => versPage(c.name, c.packed, c.uniforms, c.resident)),
    workgroup: SELECTION_WORKGROUP,
    entete: SELECTION_HEADER_WORDS,
    bitsPage: REQUEST_PAGE_MAX,
    layoutEntries: dagBindEntries(),
    bindings: DAG_BINDING,
    totaux: {
      selected: OUT_SELECTED_TRIANGLES,
      transparent: OUT_TRANSPARENT_TRIANGLES,
    },
  });
}
