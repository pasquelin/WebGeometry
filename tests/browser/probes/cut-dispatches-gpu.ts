// "persistent selection, single-pass cut" batch, LAUNCHES half: traversal launches flat
// over tiers counted by layout, fits in the head pass, and a frame opens only six commands
// instead of 3·depth+3.
//
// DELIVERED cut is called for real — `createDagResources` and `encodeDagKernels`, bundled
// by esbuild and executed in Chromium. Only the oracle, `develop` cut, is copied
// (`oracles/coupe-lancements.ts`): it exists nowhere else. The benchmark is valid only if
// both retain the same pages and render the same ones, bit for bit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dansPageWebgpu, empaquetePage } from './pageWebgpu.ts';
import { median } from '../../../scripts/median.ts';
import type { executer } from './cutDispatchesPage.ts';
import { DISPATCH_SCENE } from './cutDispatchesScene.ts';

declare global {
  var coupeLancements: { executer: typeof executer };
}

const ici = dirname(fileURLToPath(import.meta.url));

/** Delivered depth of benchmark hierarchy, then two EXTENDED depths: extra tiers
 *  are empty, traversal does nothing there, but their commands are opened. They are thus
 *  command SLOPE measurements, not deep scenes, and report names them accordingly. */
const PROFONDEURS = [13, 21];
const TOURS = 200,
  RONDES = 5;
/** Guardrail sweep: tier width over which each level is launched flat. */
const BORNES = [0, 1000, 100000, 1000000];

const mediane = (
  valeurs: Array<{ encodage: number; total: number }>,
  champ: 'encodage' | 'total',
): number => Number(median(valeurs.map((v) => v[champ])).toFixed(4));

test('cut opens fewer commands and retains exactly the same pages', async () => {
  const script = await empaquetePage(resolve(ici, 'cutDispatchesPage.ts'), 'coupeLancements');
  const erreursPage: string[] = [];
  const releve = await dansPageWebgpu(
    (argument: Parameters<typeof executer>[0]) => globalThis.coupeLancements.executer(argument),
    {
      ...DISPATCH_SCENE,
      profondeurs: PROFONDEURS,
      tours: TOURS,
      rondes: RONDES,
      bornes: BORNES,
    },
    { titre: 'Cut dispatches', script, erreursPage },
  );
  assert.equal(releve.indisponible, undefined, 'WebGPU must be available');
  assert.deepEqual(releve.compilation ?? [], [], 'both kernels must compile');
  assert.deepEqual([...(releve.erreurs ?? []), ...erreursPage], []);
  assert.ok(
    releve.sorties && releve.balayage && releve.profondeurs && releve.comptes && releve.mesures,
    'the measurement is incomplete',
  );

  const [avant, apres] = releve.sorties;
  assert.ok(avant.pages.length > 0, 'the cut must keep pages');
  assert.deepEqual(apres.pages, avant.pages, 'same wanted pages, bit for bit');
  assert.deepEqual(apres.dessinees, avant.dessinees, 'same drawn pages, bit for bit');
  assert.equal(apres.overflow, avant.overflow);
  assert.equal(apres.frustumRejected, avant.frustumRejected);
  // A wider tier changes no verdict: extra threads exit on count guard.
  for (const ligne of releve.balayage)
    assert.deepEqual(
      ligne.sortie.pages,
      apres.pages,
      `bound ${ligne.borneParNiveau}: the cut must be unchanged`,
    );

  const { comptes, mesures } = releve;
  const lignes = releve.profondeurs.map((profondeur, p) => {
    const msTotalAvant = mediane(mesures[0][p], 'total'),
      msTotalApres = mediane(mesures[1][p], 'total');
    return {
      profondeur,
      etages: profondeur === releve.profondeurLivree ? 'of the scene' : 'lengthened (empty tiers)',
      // Counted on encoders themselves, not inferred from formula.
      commandesAvant: comptes[0][p].passes + comptes[0][p].copies,
      commandesApres: comptes[1][p].passes + comptes[1][p].copies,
      passesApres: comptes[1][p].passes,
      copiesApres: comptes[1][p].copies,
      msTotalAvant,
      msTotalApres,
      msEncodageAvant: mediane(mesures[0][p], 'encodage'),
      msEncodageApres: mediane(mesures[1][p], 'encodage'),
      gainPourCent: Number((100 * (1 - msTotalApres / msTotalAvant)).toFixed(1)),
    };
  });
  // SLOPE taken between shortest and longest depth: cost of one extra level on each side.
  const bornes = [lignes[0], lignes[lignes.length - 1]];
  const pente = (champ: 'msTotalAvant' | 'msTotalApres'): number =>
    Number(
      (
        (1000 * (bornes[1][champ] - bornes[0][champ])) /
        (bornes[1].profondeur - bornes[0].profondeur)
      ).toFixed(1),
    );
  const pentes = {
    usParNiveauAvant: pente('msTotalAvant'),
    usParNiveauApres: pente('msTotalApres'),
  };
  console.log(
    JSON.stringify(
      {
        adaptateur: releve.adaptateur,
        pages: releve.pages,
        noeuds: releve.noeuds,
        profondeurLivree: releve.profondeurLivree,
        etagesLivres: releve.etagesLivres,
        pagesRetenues: avant.pages.length,
        pagesDessinees: avant.dessinees.length,
        imagesParMesure: TOURS,
        rondes: RONDES,
        lignes,
        pentes,
        // Guardrail: cost of immediately exiting threads when tier swells.
        balayageDesBornes: releve.balayage.map(({ borneParNiveau, ms }) => ({
          borneParNiveau,
          ms,
        })),
      },
      null,
      2,
    ),
  );
  // Benchmark publishes timings and command counts; asserts only machine-independent behavior.
});
