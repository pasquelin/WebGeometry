/**
 * Cut witness encoder: it dispatches nothing, it notes. What the GPU pays between two kernels is
 * counted in COMMANDS, not threads — each compute pass and each copy outside a pass empties its
 * queue and caches —, and two test files hold that contract: `live.test.ts` for the list
 * each kernel walks, `encode.test.ts` for the command count.
 */
import assert from 'node:assert/strict';
import type { encodeDagKernels } from './encode.ts';

/** `liste`: offset of the group count armed before the dispatch, hence the list walked. */
type Lancement = { noyau: string; groupes: number | 'indirect'; liste?: number };
type Copie = {
  de: string;
  decalage: number;
  vers: string;
  octets: number;
  enPasse: boolean;
};

export const LIVE = 1234,
  CAND = 3000,
  DRAWN = 4000;
/** Nodes of each stage: the upper bound on which that level's pass dispatches flat. */
export const ETAGES = [2, 9, 40, 150, 600];

/** An encoder that only notes: which kernel, dispatched flat or on which list. */
export function encodeurTemoin() {
  const lancements: Lancement[] = [];
  const copies: Copie[] = [];
  const passes: string[] = [];
  let noyau = '';
  let arme = -1;
  let ouverte = false;
  const pass = {
    setBindGroup() {},
    setPipeline(next: { entryPoint: string }) {
      noyau = next.entryPoint;
    },
    dispatchWorkgroups(groupes: number) {
      lancements.push({ noyau, groupes });
    },
    dispatchWorkgroupsIndirect(buffer: { nom: string }, decalage: number) {
      assert.equal(buffer.nom, 'dispatchArgs');
      assert.equal(decalage, 0);
      lancements.push({ noyau, groupes: 'indirect', liste: arme });
    },
    end() {
      ouverte = false;
    },
  };
  const encoder = {
    beginComputePass(descriptor: { label: string }) {
      passes.push(descriptor.label);
      ouverte = true;
      return pass;
    },
    copyBufferToBuffer(
      de: { nom: string },
      decalage: number,
      vers: { nom: string },
      _cible: number,
      octets: number,
    ) {
      copies.push({ de: de.nom, decalage, vers: vers.nom, octets, enPasse: ouverte });
      if (vers.nom === 'dispatchArgs') arme = decalage;
    },
  };
  return { encoder, lancements, copies, passes };
}

/** A stage named as the witness will see it pass: `encode.ts` destructures these fields
 *  by name, and writing them here makes them searchable from it. */
const etape = (entryPoint: string) => ({ entryPoint });

export function ressources(residentCut: boolean, levelCount = 3, pageCount = 4096) {
  return {
    residentCut,
    pageCount,
    nodeCount: 64,
    worldCount: 2,
    blockCount: 64,
    levelSizes: Uint32Array.from(ETAGES.slice(0, levelCount)),
    liveGroupsOffset: LIVE,
    candGroupsOffset: CAND,
    drawnGroupsOffset: DRAWN,
    work: { nom: 'work' },
    dispatchArgs: { nom: 'dispatchArgs' },
    bindGroup: {},
    levelPipelines: [etape('dagLevel0'), etape('dagLevel1'), etape('dagLevel2')],
    preparePipeline: etape('dagPrepare'),
    clearDrawnPipeline: etape('dagClearDrawn'),
    wantedPipeline: etape('dagWanted'),
    maskPipeline: etape('dagMask'),
    drawPrefixPipeline: etape('dagDrawPrefix'),
    drawScatterPipeline: etape('dagDrawScatter'),
    viewOffsetsPipeline: etape('dagViewOffsets'),
    requestSortPipeline: etape('dagSortRequests'),
  } as unknown as Parameters<typeof encodeDagKernels>[1];
}
