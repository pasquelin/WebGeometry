/**
 * Page side of the dispatch measurement: the engine's REAL cut — `createDagResources` and
 * `encodeDagKernels` — against the cut from before, copied in `oracles/coupe-lancements.ts`.
 * Bundled by esbuild then run in Chromium, like `parentedCameraGpuPage.ts`.
 *
 * The shipped side is not rewritten here. That is the only way to measure what a frame actually
 * costs: a hand-copied encoder measures the copy, and the discrepancy with the original is never
 * seen. Only the oracle is written by hand, because it no longer exists.
 *
 * What the GPU pays between two kernels is not counted in threads but in COMMANDS: each compute
 * pass and each copy outside a pass close the current encoder and open another. The bench
 * therefore measures the WHOLE SEQUENCE of a frame, never an isolated kernel, and alternates
 * variants so thermal drift falls on both sides.
 */
import { createDagResources } from '../../../packages/sdk-browser/src/gpu/dag/resources.ts';
import { encodeDagKernels } from '../../../packages/sdk-browser/src/gpu/dag/encode.ts';
import { packedWorldsToRenderOrigin } from '../../../packages/sdk-browser/src/gpu/dag/pack.ts';
import * as G from '../../../packages/sdk-browser/src/host/graph/graph.fixture.ts';
import {
  cameraSelectionUniforms,
  SELECTION_UNIFORM_BYTES,
} from '../../../packages/sdk-browser/src/gpu/core/selection.ts';
import { writeDagUniforms } from '../../../packages/sdk-browser/src/gpu/dag/uniforms.ts';
import { SELECTION_HEADER_WORDS } from '../../../packages/sdk-browser/src/gpu/dag/layout.ts';
import { cameraMoteur } from '../../../packages/sdk-browser/src/camera/camera.fixture.ts';
import { encodeAvant, ressourcesAvant } from '../../../bench/oracles/browser/cut-dispatches.ts';
import { DAG_SELECTION_SHADER_AVANT } from '../../../bench/oracles/browser/cut-dispatches-wgsl.ts';
import { ouvrirAppareil } from './webgpuDevice.ts';
import { commandes, scene } from './cutDispatchesScene.ts';
import { median } from '../../../scripts/median.ts';
import type { ExecuterParams, ExecuterResultat } from './cutDispatchesTypes.ts';

export async function executer({
  feuilles,
  niveaux,
  profondeurs,
  tours,
  rondes,
  bornes,
}: ExecuterParams): Promise<ExecuterResultat> {
  const appareil = await ouvrirAppareil();
  if (!appareil) return { indisponible: 'no WebGPU adapter' };
  const { device, erreurs } = appareil;
  const { packed, roots } = scene(feuilles, niveaux);
  const camera = G.perspectiveCamera(55, 16 / 9, 0.1, 200);
  camera.position.set(0, 0, 16);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const uniforms = cameraSelectionUniforms(cameraMoteur(camera), 1, [1280, 720]);
  packedWorldsToRenderOrigin(packed, roots, uniforms.cameraWorld);

  // The shipped side: its buffers, its stages, its encode. Nothing of it is rewritten.
  const livre = await createDagResources(device, packed, true);
  if (!livre) return { indisponible: 'the shipped cut does not mount' };
  const { module, compilation } = await appareil.compile(DAG_SELECTION_SHADER_AVANT);
  if (compilation.length) return { compilation, erreurs };
  // `ressourcesAvant`'s own `PackedAvant` is a private, unexported interface: `packed` (`PackedDag`)
  // is structurally what it reads (`levelSizes` included, indexed and measured by `.length`, which
  // `Uint32Array` supports even where the private type says `readonly unknown[]`).
  const avant = ressourcesAvant(
    device,
    module,
    livre.layout,
    packed as unknown as Parameters<typeof ressourcesAvant>[3],
    livre.readbackBytes,
  );

  const uni = new Float32Array(SELECTION_UNIFORM_BYTES / 4);
  writeDagUniforms(uni, packed, uniforms, true);
  device.queue.writeBuffer(livre.uniforms, 0, uni);
  device.queue.writeBuffer(avant.uniforms, 0, uni);

  const lecture = device.createBuffer({
    size: livre.readbackBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const relire = async (sortie: GPUBuffer) => {
    const copie = device.createCommandEncoder();
    copie.copyBufferToBuffer(sortie, 0, lecture, 0, livre.readbackBytes);
    device.queue.submit([copie.finish()]);
    await lecture.mapAsync(GPUMapMode.READ);
    const ints = new Uint32Array(lecture.getMappedRange().slice(0));
    lecture.unmap();
    const tete = livre.outputBytes / 4;
    const entete = SELECTION_HEADER_WORDS;
    const liste = (at: number): number[] =>
      Array.from(ints.subarray(at + entete, at + entete + Math.min(ints[at], packed.pageCount)));
    return {
      pages: liste(0).sort((a, b) => a - b),
      dessinees: liste(tete),
      frustumRejected: ints[1],
      overflow: ints[3],
    };
  };

  /**
   * A batch of frames, and the TWO times that must be separated: the one the CPU spends writing
   * commands, and the one we still wait once the last is submitted. Confusing them would
   * attribute a CPU encode to the GPU, which is not the same spend.
   */
  const lot = async (encode: (encoder: GPUCommandEncoder) => void, nombre: number) => {
    const debut = performance.now();
    for (let image = 0; image < nombre; image++) {
      const encoder = device.createCommandEncoder();
      encode(encoder);
      device.queue.submit([encoder.finish()]);
    }
    const ecrit = performance.now();
    await device.queue.onSubmittedWorkDone();
    return { encodage: (ecrit - debut) / nombre, total: (performance.now() - debut) / nombre };
  };

  // Tiers on which the shipped descent launches flat. Lengthening them changes no verdict —
  // extra threads exit on the count guard — and gives the depth we want.
  const etages = (profondeur: number, largeur: number): Uint32Array =>
    Uint32Array.from({ length: profondeur }, (_, l) =>
      l < packed.levelSizes.length ? Math.max(packed.levelSizes[l], largeur) : largeur,
    );
  const variantes: Array<{
    nom: string;
    sortie: GPUBuffer;
    encode: (e: GPUCommandEncoder, p: number) => void;
  }> = [
    {
      nom: 'avant (two queues, indirect and armed level)',
      sortie: avant.output,
      encode: (e, p) => encodeAvant(e, avant, p),
    },
    {
      nom: 'apres (the shipped cut, flat descent in one pass)',
      sortie: livre.output,
      encode: (e, p) => encodeDagKernels(e, { ...livre, levelSizes: etages(p, 0) }),
    },
  ];

  // Scene depth first, then those we lengthen: extra tiers are empty.
  const toutes = [packed.levelSizes.length, ...profondeurs];
  const comptes = variantes.map((v) => toutes.map((p) => commandes((e) => v.encode(e, p))));
  const mesures: Array<Array<Array<{ encodage: number; total: number }>>> = variantes.map(() =>
    toutes.map(() => []),
  );
  for (let ronde = 0; ronde < rondes; ronde++)
    for (let v = 0; v < variantes.length; v++)
      for (let p = 0; p < toutes.length; p++) {
        const encode = (e: GPUCommandEncoder) => variantes[v].encode(e, toutes[p]);
        await lot(encode, Math.max(2, tours >> 2));
        mesures[v][p].push(await lot(encode, tours));
      }
  const sorties = [];
  for (const variante of variantes) {
    await lot((e) => variante.encode(e, packed.levelSizes.length), 1);
    sorties.push({ nom: variante.nom, ...(await relire(variante.sortie)) });
  }

  // The guardrail: the shipped descent launched on ever-wider stages, the scene
  // unchanged. That is the price of threads that exit at once, and the margin left before
  // the flat launch becomes more expensive again than the arming it replaces.
  const balayage = [];
  for (const largeur of bornes) {
    const encode = (e: GPUCommandEncoder) =>
      encodeDagKernels(e, { ...livre, levelSizes: etages(packed.levelSizes.length, largeur) });
    await lot(encode, Math.max(2, tours >> 2));
    const releve = [];
    for (let ronde = 0; ronde < rondes; ronde++) releve.push(await lot(encode, tours));
    balayage.push({
      borneParNiveau: largeur,
      ms: Number(median(releve.map((m) => m.total)).toFixed(4)),
      sortie: await relire(livre.output),
    });
  }

  const info = await appareil.fermer();
  return {
    adaptateur: info.court,
    erreurs,
    pages: packed.pageCount,
    noeuds: packed.nodeCount,
    profondeurLivree: packed.levelSizes.length,
    profondeurs: toutes,
    etagesLivres: Array.from(packed.levelSizes),
    noms: variantes.map((v) => v.nom),
    comptes,
    mesures,
    sorties,
    balayage,
  };
}
