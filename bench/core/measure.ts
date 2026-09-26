// Absolute measurement of an engine calculation, on named cases, against an oracle.
// This file only measures and compares: table, fragments, baselines and path
// checking of cited files are managed by `report.ts`.
import { ecartRelatif } from './baseline.ts';
import { ecart } from './diff.ts';
import type { Compteur } from './ulp.ts';
import type {
  Stats,
  LigneResultat,
  Mesure,
  MesureCas,
  MesureParams,
  Reglages,
  Verdict,
} from './measureTypes.ts';
import { ligne } from './measureTypes.ts';

export function graine(depart: number) {
  let etat = depart >>> 0 || 0x9e3779b9;
  return () => {
    etat = (etat ^ (etat << 13)) >>> 0;
    etat = (etat ^ (etat >>> 17)) >>> 0;
    etat = (etat ^ (etat << 5)) >>> 0;
    return etat / 4294967296;
  };
}

function stats(durees: number[]): Stats {
  const t = durees.slice().sort((a, b) => a - b);
  const n = t.length;
  const milieu = n >> 1;
  const medianeMs = n % 2 ? t[milieu] : (t[milieu - 1] + t[milieu]) / 2;
  const i95 = Math.min(Math.ceil(n * 0.95) - 1, n - 1);
  return { medianeMs, p95Ms: t[i95], minMs: t[0], tours: n };
}

const compteTexte = (c: Compteur) => `${c.nombre} discrepancy(ies), ${c.ulpMax} ULP at most`;

interface VerifieConf<Entree, Sortie> {
  calcul: (input: Entree) => Sortie | Promise<Sortie>;
  attendu?: (input: Entree) => Sortie | Promise<Sortie>;
  differences?: (ref: Sortie, obt: Sortie, chemin: string) => Compteur;
  motif?: string | null;
}

/**
 * Compares a case to its oracle. Without `differences`, equality is strict bitwise; with, the
 * count of discrepancies is published as is — the benchmark then measures a REFUSED candidate and quantifies what it
 * displaces, instead of demanding equality that does not apply. The caller's `motif` is always
 * kept: without an oracle it says where correctness is held, with one it says what the comparison
 * leaves out; never silence.
 */
async function verifie<Entree, Sortie>(
  item: MesureCas<Entree>,
  { calcul, attendu, differences, motif }: VerifieConf<Entree, Sortie>,
): Promise<Verdict> {
  if (!attendu) return { correct: null, difference: null, motif: motif ?? null };
  const ref = await attendu(item.input);
  const obt = await calcul(item.input);
  if (!differences) {
    const diff = ecart(ref, obt, item.name);
    return { correct: diff === null, difference: diff, motif: motif ?? null };
  }
  const compte = compteTexte(differences(ref, obt, item.name));
  return { correct: null, difference: null, motif: motif ? `${compte} ; ${motif}` : compte };
}

/**
 * Absolute measurement of a calculation on a set of named cases, each verified against `attendu`.
 * `fichier` is the measured path, or list of paths; `mesure: false` on a case verifies it without timing.
 * `temoin` is another calculation of the same thing, timed under the same settings: its statistics
 * go under `temoin` and `ecartTemoin` reads the calculation's median against its (`null` without).
 */
export async function mesure<Entree = unknown, Sortie = unknown>({
  name,
  fichier,
  cas,
  options = {},
  ...conf
}: MesureParams<Entree, Sortie>): Promise<Mesure> {
  const reglages: Reglages = { chauffe: 20, tours: 200, budgetMs: 1000, ...options };
  const resultats: LigneResultat[] = [];

  for (const item of cas) {
    const verdict = await verifie(item, conf);

    if (item.mesure === false) {
      resultats.push(ligne({ ...verdict, name: item.name, size: item.size ?? null }));
      continue;
    }

    const t = conf.temoin ? await chronometre(conf.temoin, item.input, reglages) : null;
    const s = await chronometre(conf.calcul, item.input, reglages);
    const taille = item.size ?? null;
    resultats.push({
      name: item.name,
      size: taille,
      ...s,
      nsParElement: taille !== null && taille > 0 ? (s.medianeMs * 1e6) / taille : null,
      opsParSec: s.medianeMs > 0 ? Math.round(1000 / s.medianeMs) : null,
      temoin: t,
      ecartTemoin: ecartRelatif(s.medianeMs, t?.medianeMs),
      ...verdict,
    });
  }
  return { name, fichier, resultats };
}

/** Warm-up, then timed turns until `tours` or the budget: the statistics of one calculation on one input. */
async function chronometre<Entree>(
  calcul: (input: Entree) => unknown,
  input: Entree,
  { chauffe, tours, budgetMs }: Reglages,
): Promise<Stats> {
  for (let i = 0; i < chauffe; i++) await calcul(input);

  // Two clock readings per turn, not three: the end of a turn is also where the
  // budget is evaluated. The timer wraps exactly the call, as before.
  const durees: number[] = [];
  const debut = process.hrtime.bigint();
  let fin: bigint;
  while (durees.length < tours) {
    const t0 = process.hrtime.bigint();
    await calcul(input);
    fin = process.hrtime.bigint();
    durees.push(Number(fin - t0) / 1e6);
    if (durees.length >= 5 && Number(fin - debut) / 1e6 > budgetMs) break;
  }
  return stats(durees);
}
