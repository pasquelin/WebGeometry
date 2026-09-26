// #709 left every level of a masked chain unwritten — alpha 0 — and every leaf cut; #748 keeps each
// level's coverage at level 0's, and #769 WebGL2's, measured on the filtered cut since #43. Without
// a browser: each backend's shipped counts (`cutBin`), reduction (`reducedAlpha`) and pick run on
// the CPU (`shaderRule.fixture.ts`) over the whole chain of `leaves-cut-by-alpha`'s leaf, 256², cut
// at 0.5 (C = 128), and of the compiler's noise table, whose texel and filtered counts disagree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIP_SHADER } from './mips.ts';
import { COVERAGE_WGSL } from './coverageMips.ts';
import { readFileSync } from 'node:fs';
import { COVERAGE_PICK_GLSL } from './coverageRule.ts';
import { MIP_FRAGMENT_GLSL } from '../webgl/cluster/mips.ts';
import { COVERAGE_COUNT_GLSL } from '../webgl/cluster/coverageMips.ts';
import { shaderFunctions, vec } from './shaderRule.fixture.ts';
import { leafAlpha } from '../../../../tests/fixtures/leafTexture.ts';

const C = 128;
type Alpha = { x: number; y: number; z: number; w: number };
type Reduction = {
  median(a: Alpha): number;
  reducedAlpha(a: Alpha, c: number, t: number): number;
  pick(c: number, covered: number, texels: ReturnType<typeof vec>): number;
  filtered(a: ReturnType<typeof vec>, s: number): number;
  cutBin(a: ReturnType<typeof vec>, s: number, c: number): number;
};
type Level = { alpha: Uint8Array; side: number };

/** The shipped functions of a shader text, their histogram answering `binOf`. */
function shipped(shader: string) {
  const bins = { histogram: [] as number[] };
  const names = ['toByte', 'median', 'scaled', 'reducedAlpha', 'wide', 'below', 'apart', 'pick'];
  names.push('filtered', 'cutBin'); // the cut (#43)
  const run = shaderFunctions<Reduction>(shader, names, {
    binOf: (t: number) => bins.histogram[t],
  });
  return { run, bins };
}

/** Every filtered sample of a square level, four a texel, from the corner alphas of its square —
 *  an edge texel its own neighbour — as the counts read them. */
function samples(
  { alpha, side }: Level,
  each: (corners: ReturnType<typeof vec>, s: number) => void,
) {
  const at = (x: number, y: number) => alpha[Math.min(y, side - 1) * side + Math.min(x, side - 1)];
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const corners = vec(at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1));
      for (let s = 0; s < 4; s++) each(corners, s);
    }
}

/** The chain a shader text builds from a square `level0`, as the GPU runs it (`generateMaterialMips`):
 *  per level, the four taps of the level above clamped at its edge, the count's histogram of their
 *  medians' filtered samples and its `t`, then each texel's `reducedAlpha` stored as a byte. */
function chainOf(shader: string, cutoff: number, level0: Level) {
  const { run, bins } = shipped(shader);
  const counted = (level: Level) => {
    bins.histogram = Array<number>(256).fill(0);
    samples(level, (corners, s) => bins.histogram[run.cutBin(corners, s, cutoff)]++);
    return bins.histogram;
  };
  const covered =
    cutoff &&
    counted(level0)
      .slice(cutoff)
      .reduce((sum, n) => sum + n, 0);
  const levels: Level[] = [level0];
  for (let side = level0.side >> 1; side >= 1; side >>= 1) {
    const above = levels.at(-1)!,
      tap = (x: number, y: number) => above.alpha[y * above.side + x] / 255;
    const taps = Array.from({ length: side * side }, (_, i) => {
      const [x, y] = [(i % side) * 2, Math.floor(i / side) * 2];
      return { x: tap(x, y), y: tap(x + 1, y), z: tap(x, y + 1), w: tap(x + 1, y + 1) };
    });
    let t = 0;
    if (cutoff) {
      counted({ alpha: Uint8Array.from(taps, (a) => run.median(a)), side });
      t = run.pick(cutoff, covered, vec(level0.side ** 2, side * side));
    }
    const alpha = Uint8Array.from(taps, (a) => Math.round(run.reducedAlpha(a, cutoff, t) * 255));
    levels.push({ alpha, side });
  }
  return { levels, run };
}

/** A level's filtered samples at or above C. */
function coveredOf(run: Reduction, level: Level) {
  let kept = 0;
  samples(level, (corners, s) => (kept += Number(run.filtered(corners, s) >= C)));
  return kept;
}

/** Every level written, never all transparent, its filtered samples at or above C level 0's share
 *  within 2.5 % or one texel's four — a level cannot hold a fraction of one. */
function holdsCoverage({ levels, run }: ReturnType<typeof chainOf>) {
  const share = coveredOf(run, levels[0]) / levels[0].alpha.length;
  levels.forEach(({ alpha, side }, level) => {
    assert.ok(alpha, `level ${level} written`);
    assert.ok(
      alpha.some((a) => a > 0),
      `level ${level} is not all transparent`,
    );
    const kept = coveredOf(run, { alpha, side }),
      target = share * alpha.length;
    const tolerance = Math.max(0.025 * target, 4);
    assert.ok(Math.abs(kept - target) <= tolerance, `level ${level}: ${kept} kept, ${target} due`);
  });
}

const leaf: Level = { alpha: leafAlpha(256), side: 256 };
const noise = JSON.parse(
  readFileSync(
    new URL('../../../../tests/fixtures/formats/previews/coverage-filtered.json', import.meta.url),
    'utf8',
  ),
) as { cutoff: number; side: number; alpha: string[]; covered: number[] };
const noiseLevel: Level = {
  alpha: Uint8Array.from(noise.alpha.join(' ').split(' '), Number),
  side: noise.side,
};

/** Each backend's reduction and pick as shipped, what it stores, and its scale's last line. */
const BACKENDS = {
  WebGPU: {
    shipped: MIP_SHADER + COVERAGE_WGSL,
    stored: 'reducedAlpha(a,extent.z,extent.w))',
    scale: 'return f32(scaled(median(a),c,t))/255.0;',
  },
  WebGL2: {
    shipped: MIP_FRAGMENT_GLSL + COVERAGE_PICK_GLSL + COVERAGE_COUNT_GLSL,
    stored: 'reducedAlpha(a,cutoff,t));',
    scale: 'return float(scaled(median(a),c,t))/255.;',
  },
};

for (const [backend, { shipped, stored, scale }] of Object.entries(BACKENDS)) {
  test(`the shipped ${backend} reduction keeps the leaf’s coverage at every level of its chain`, () => {
    assert.ok(shipped.includes(stored), 'the texel it stores');
    holdsCoverage(chainOf(shipped, C, leaf));
  });

  // The measurer's proof of #43: at 4² the leaf's stored level passed 38 samples at the engine's
  // cut, `alpha >= 0.5` on the filtered value, where the counts, rounding it down, saw 36.
  test(`${backend}'s filtered cut is the engine's, at alphaTest 0.5, on every level`, () => {
    const { levels, run } = chainOf(shipped, C, leaf);
    const weights = [9, 3, 3, 1];
    for (const [k, level] of levels.entries()) {
      let engine = 0;
      samples(level, ({ x, y, z, w }, s) => {
        const near = [x, y, z, w].map((_, i) => [x, y, z, w][i ^ s]);
        engine += Number(near.reduce((v, a, i) => v + weights[i] * a, 0) / 16 / 255 >= 0.5);
      });
      assert.equal(coveredOf(run, level), engine, `level ${k}`);
    }
  });

  // #43: on noise the texel counts and the filtered cut disagree. The shipped counts hold the
  // filtered share, each level within 2.5 % of the compiler's; counting texels — develop's rule,
  // every sample filed under its texel's own byte — strays from 16².
  test(`${backend} counts coverage on the filtered cut, as the compiler does`, () => {
    const chain = chainOf(shipped, noise.cutoff, noiseLevel);
    holdsCoverage(chain);
    chain.levels.forEach((level, k) => {
      const kept = coveredOf(chain.run, level),
        due = noise.covered[k];
      assert.ok(Math.abs(kept - due) <= 0.025 * due, `level ${k}: ${kept}, the compiler ${due}`);
    });
    const texels = shipped.replace('return low;', 'return a.x;');
    assert.notEqual(texels, shipped);
    assert.throws(
      () => holdsCoverage(chainOf(texels, noise.cutoff, noiseLevel)),
      /level 1: 490 kept/,
    );
  });

  test(`${backend}: a chain left unwritten, zeroed, thinned or grown by the median is refused`, () => {
    const chain = chainOf(shipped, C, leaf);
    const unwritten = chain.levels.map((level, k) => (k ? { ...level, alpha: null! } : level));
    assert.throws(() => holdsCoverage({ ...chain, levels: unwritten }), /level 1 written/);
    chain.levels.slice(1).forEach(({ alpha }) => alpha.fill(0));
    assert.throws(() => holdsCoverage(chain), /level 1 is not all transparent/);
    const broken = shipped.replace(scale, 'return 0.0;');
    assert.notEqual(broken, shipped);
    assert.throws(() => holdsCoverage(chainOf(broken, C, leaf)), /level 1 is not all transparent/);
    // The median alone — develop's chain before #748 — grows this leaf at 4².
    assert.throws(() => holdsCoverage(chainOf(shipped, 0, leaf)), /level 6: /);
  });
}
