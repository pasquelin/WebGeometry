import { fingerprintBuild } from '../../../scripts/write-build-provenance.ts';
import { analyseFile, neighboringCut } from '../cutAnalysis.ts';
import { readsCache, sceneDerived } from '../scene.ts';
import { assetIdentity } from './provenance.ts';
import type { SideBase } from '../dists.ts';
import type { Report } from './types.ts';

/** Freeze asset/build identity and cut analysis while the measured inputs are still present. */
export async function recordInputs(report: Report, sides: SideBase[]) {
  for (const side of sides) {
    if (readsCache(report.scene))
      report.sides[side.name].assetKey = assetIdentity(side.cache ?? sceneDerived(report.scene));
    report.sides[side.name].buildHash = (await fingerprintBuild(side.dist)).hash;
  }
}
export async function recordCuts(report: Report, sides: SideBase[], out: string) {
  for (const series of report.series) {
    for (const side of sides) {
      const reading = series.sides?.[side.name];
      if (!reading) continue;
      try {
        reading.cutAnalysis = await analyseFile(
          neighboringCut(out, reading.png),
          side.cache ?? sceneDerived(report.scene),
        );
      } catch (error) {
        reading.cutAnalysis = null;
        const message = error instanceof Error ? error.message : String(error);
        report.errors.push({ kind: 'cut-analysis', message });
      }
    }
  }
}
