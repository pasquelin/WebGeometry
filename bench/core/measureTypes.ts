// The shapes `measure.ts` measures with: statistics, result lines, cases and parameters.
import type { Compteur } from './ulp.ts';

export interface Stats {
  medianeMs: number;
  p95Ms: number;
  minMs: number;
  tours: number;
}

/** One measured or described row of a benchmark. */
export interface LigneResultat {
  name: string;
  size: number | null;
  medianeMs: number | null;
  p95Ms: number | null;
  minMs: number | null;
  nsParElement: number | null;
  tours: number;
  opsParSec: number | null;
  temoin: Stats | null;
  ecartTemoin: number | null;
  correct: boolean | null;
  difference: string | null;
  motif: string | null;
  /** Added by `report.ts` against the domain baseline; absent before that. */
  ecartBaseline?: number | null;
}

/** A row no timer fed, `null` never zero: its name, and what verifies it. */
export const ligne = (
  row: Pick<LigneResultat, 'name'> &
    Partial<Pick<LigneResultat, 'size' | 'motif' | 'correct' | 'difference'>>,
): LigneResultat => ({
  size: null,
  medianeMs: null,
  p95Ms: null,
  minMs: null,
  nsParElement: null,
  tours: 0,
  opsParSec: null,
  temoin: null,
  ecartTemoin: null,
  correct: null,
  difference: null,
  motif: null,
  ...row,
});

/** A named benchmark's result: the file(s) it measures and its rows, one per case. */
export interface Mesure {
  name: string;
  fichier: string | string[];
  resultats: LigneResultat[];
}

/** One named input to measure, or to verify only when `mesure` is `false`. */
export interface MesureCas<Entree = unknown> {
  name: string;
  input: Entree;
  size?: number | null;
  mesure?: boolean;
}

export interface Reglages {
  chauffe: number;
  tours: number;
  budgetMs: number;
}

export interface Verdict {
  correct: boolean | null;
  difference: string | null;
  motif: string | null;
}

/** Parameters of `mesure`: the calculation, its oracle, and the settings it measures under. */
export interface MesureParams<Entree = unknown, Sortie = unknown> {
  name: string;
  fichier: string | string[];
  cas: MesureCas<Entree>[];
  options?: Partial<Reglages>;
  calcul: (input: Entree) => Sortie | Promise<Sortie>;
  attendu?: (input: Entree) => Sortie | Promise<Sortie>;
  temoin?: (input: Entree) => unknown;
  differences?: (ref: Sortie, obt: Sortie, chemin: string) => Compteur;
  motif?: string | null;
}

/** Pseudo-random generator with fixed seed (xorshift32): two executions see the same inputs. */
