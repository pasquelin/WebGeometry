import { sceneView } from './cutDispatchesScene.ts';
import { median } from '../../../scripts/median.ts';
/**
 * Page side of the READOUT measurement: what a frame pays to bring the cut back, on the engine's
 * real cut (`createDagResources`, `encodeDagKernels`) and a real device.
 *
 * The readout buffer is sized for the WORST CASE — `16 + pageCount*4` for the wanted cut, as
 * much for the drawable cut (`packages/sdk-browser/src/gpu/dag/resources.ts`) — and the frame copy takes all of it. At
 * two million clusters that is sixteen megabytes copied and mapped per frame for a few tens
 * of thousands of useful numbers. The bench measures both copy sizes on the SAME kernel
 * encode: only the copy size changes, so the gap is the worst-case price.
 *
 * The read is SERIALISED here — copy, submit, `mapAsync`, read — where the engine double-
 * buffers it: this figure is the total work of a frame, not the stall it suffers.
 * `encodage` splits it from what the CPU spends writing commands.
 */
import { createDagResources } from '../../../packages/sdk-browser/src/gpu/dag/resources.ts';
import { encodeDagKernels } from '../../../packages/sdk-browser/src/gpu/dag/encode.ts';
import { SELECTION_UNIFORM_BYTES } from '../../../packages/sdk-browser/src/gpu/core/selection.ts';
import { writeDagUniforms } from '../../../packages/sdk-browser/src/gpu/dag/uniforms.ts';
import { SELECTION_HEADER_WORDS } from '../../../packages/sdk-browser/src/gpu/dag/layout.ts';
import { ouvrirAppareil } from './webgpuDevice.ts';

interface ExecuterParams {
  tailles: number[];
  niveaux: number;
  tours: number;
  rondes: number;
  plafond: number;
  erreurs: number[];
}
export type Ligne = { feuilles: number; refus: string } | Awaited<ReturnType<typeof mesure>>;

export async function executer({
  tailles,
  niveaux,
  tours,
  rondes,
  plafond,
  erreurs: seuils,
}: ExecuterParams) {
  const appareil = await ouvrirAppareil();
  if (!appareil) return { indisponible: 'no WebGPU adapter' };
  const { device, erreurs } = appareil;

  const lignes: Ligne[] = [];
  for (const feuilles of tailles) {
    let ligne: Ligne;
    try {
      ligne = await mesure(device, sceneView(feuilles, niveaux), { tours, rondes, seuils });
    } catch (error) {
      lignes.push({ feuilles, refus: String(error instanceof Error ? error.message : error) });
      break;
    }
    lignes.push(ligne);
  }
  const info = await appareil.fermer();
  return { adaptateur: info.court, erreurs, plafond, lignes };
}

async function mesure(
  device: GPUDevice,
  { packed, uniforms }: ReturnType<typeof sceneView>,
  { tours, rondes, seuils }: { tours: number; rondes: number; seuils: number[] },
) {
  const livre = await createDagResources(device, packed, true);
  if (!livre) throw new Error('the shipped cut does not mount');
  const uni = new Float32Array(SELECTION_UNIFORM_BYTES / 4);
  /** The frame's screen threshold: it is what decides the CUT SIZE, hence what a
   *  cap can lose. Time is measured at the last one set. */
  const poseSeuil = (erreur: number): void => {
    writeDagUniforms(uni, packed, { ...uniforms, pixelError: erreur }, true);
    device.queue.writeBuffer(livre.uniforms, 0, uni);
  };
  poseSeuil(1);

  // YESTERDAY's sizing, kept as a measurement point: the header plus `pageCount` rows per
  // half, the worst case of a cut that would keep the whole catalogue. Production no longer
  // allocates it (the cap replaced it), but a copy's cost depends only on its SIZE: a buffer
  // of the same size measures it faithfully, and it is the only way to keep the "before"
  // reproducible.
  const octetsPireCas = 2 * (SELECTION_HEADER_WORDS * 4 + packed.pageCount * 4);
  const source = device.createBuffer({
    size: octetsPireCas,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const lecture = device.createBuffer({
    size: Math.max(octetsPireCas, livre.readbackBytes),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  /** A whole frame: the kernels, the readout copy, then its read. */
  const image = async (
    octets: number,
    depuis: GPUBuffer = livre.output,
  ): Promise<number | undefined> => {
    const encoder = device.createCommandEncoder();
    encodeDagKernels(encoder, livre);
    if (octets) encoder.copyBufferToBuffer(depuis, 0, lecture, 0, octets);
    device.queue.submit([encoder.finish()]);
    if (!octets) {
      await device.queue.onSubmittedWorkDone();
      return undefined;
    }
    await lecture.mapAsync(GPUMapMode.READ);
    const ints = new Uint32Array(lecture.getMappedRange(0, octets));
    const tete = ints[0];
    lecture.unmap();
    return tete;
  };
  const lot = async (
    octets: number,
    nombre: number,
    depuis?: GPUBuffer,
  ): Promise<{ ms: number }> => {
    const debut = performance.now();
    for (let i = 0; i < nombre; i++) await image(octets, depuis ?? livre.output);
    return { ms: (performance.now() - debut) / nombre };
  };

  // The screen threshold swept: the cut it keeps says which cap a scene of this size
  // actually hits. Measured, never assumed.
  const coupes: Array<{ erreur: number; coupe: number | undefined }> = [];
  for (const erreur of seuils) {
    poseSeuil(erreur);
    coupes.push({ erreur, coupe: await image(livre.readbackBytes) });
  }
  poseSeuil(seuils[seuils.length - 1]);
  // Three variants, including one WITH NO readout: that is what splits the copy's cost from
  // the kernel's. Without that zero, the gap between the other two would be read on a total
  // the cut dominates.
  const variantes: Array<{ nom: string; octets: number; source?: GPUBuffer }> = [
    { nom: 'no readout (kernels only)', octets: 0 },
    { nom: 'shipped readout (capped)', octets: livre.readbackBytes },
    { nom: "worst-case readout (yesterday's sizing)", octets: octetsPireCas, source },
  ];
  const mesures: Array<Array<{ ms: number }>> = variantes.map(() => []);
  for (let ronde = 0; ronde < rondes; ronde++)
    for (let v = 0; v < variantes.length; v++) {
      if (!ronde) await lot(variantes[v].octets, Math.max(2, tours >> 2), variantes[v].source);
      mesures[v].push(await lot(variantes[v].octets, tours, variantes[v].source));
    }
  for (const buffer of livre.buffers) buffer.destroy();
  lecture.destroy();
  source.destroy();
  return {
    pages: packed.pageCount,
    noeuds: packed.nodeCount,
    coupes,
    octetsLivre: livre.readbackBytes,
    octetsPireCas,
    variantes: variantes.map((v, i) => {
      const lots = mesures[i].map((m) => m.ms);
      return {
        nom: v.nom,
        octets: v.octets,
        ms: Number(median(lots).toFixed(4)),
        // Spread of the rounds: the band in which this card returns the SAME measurement. A
        // gap that does not leave it is not a gap, and the bench refuses to claim it.
        etendue: Number((Math.max(...lots) - Math.min(...lots)).toFixed(4)),
      };
    }),
  };
}
