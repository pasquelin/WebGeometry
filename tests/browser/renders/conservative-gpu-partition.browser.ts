// Proof on the real engine: GPU partition is CONSERVATIVE, cluster by cluster.
//
// The bench scene (twelve instances), the bench trajectory, thirty poses along it. After
// each frame, `partitionAudit()` returns what the GPU wrote for EVERY resident row —
// screen rectangle and depth bound — with world corners in double precision and the
// matrices it was taken from. The reference is recomputed on those same inputs, and
// three rules are counted on every row of every pose:
//   1. the GPU rectangle contains the reference's;
//   2. a box the reference says is cut by the near plane carries the clip flag;
//   3. GPU depth is a lower bound of the reference's, layer bias included.
// Zero violations is the only acceptable value. Margins are reported for themselves.
//
//   node --experimental-strip-types tests/browser/renders/conservative-gpu-partition.browser.ts
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { launchChrome } from '../../../bench/runner/chrome.ts';
import { empaquetePage } from '../probes/pageWebgpu.ts';
import { startServer } from '../../kit/server/staticServer.ts';
import {
  ASSETS,
  DEFAULT_SCENE,
  assetsManifest,
  sceneDerived,
} from '../../../bench/runner/scene.ts';
import { poseAt } from '../../../bench/runner/poses.ts';
import { cacheHoldsBlend } from '../../../bench/runner/cacheManifest.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const SDK_URL = '/sdk/witnesses/measurement.js',
  MODULES_URL = '/preuve/',
  MESURE_URL = '/runner/';
const POSES = 30;
/** Directory of an installed package, looked up the way Node does: from the root upward. */
function packageDir(name: string) {
  for (let dir = ROOT; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) throw new Error(`package not found: ${name}`);
  }
}

const manifestUrl = assetsManifest(DEFAULT_SCENE, true);
assert.ok(
  existsSync(join(ROOT, 'dist/witnesses/measurement.js')),
  'dist missing: run `pnpm run build` before this proof',
);
// The page module is bundled from the repository SOURCES, so it reads the production reference
// itself rather than a copy. The bundle is served as an ordinary file, same as dist.
const audit = await empaquetePage(
  join(ROOT, 'tests/browser/support/conservativePartitionPage.ts'),
  undefined,
  {
    format: 'esm',
  },
);
const preuveDir = await mkdtemp(join(tmpdir(), 'trillion3d-preuve-partition-'));
await writeFile(join(preuveDir, 'audit.js'), audit);

const mounts = [
  { prefix: '/vendor/three/', dir: packageDir('three') },
  { prefix: '/vendor/meshoptimizer/', dir: packageDir('meshoptimizer') },
  { prefix: '/benchmark-assets/', dir: ASSETS },
  { prefix: '/runner/', dir: join(ROOT, 'bench/runner') },
  { prefix: '/preuve/', dir: preuveDir },
  { prefix: '/sdk/', dir: join(ROOT, 'dist') },
].map((mount) => ({ ...mount, dir: resolve(mount.dir) }));

const { server, port } = await startServer({ mounts });
const browser = await launchChrome({ headless: true });
let resultat;
const erreursPage: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1012, height: 1000 } });
  page.on('pageerror', (e) => erreursPage.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') erreursPage.push(m.text().slice(0, 400));
  });
  page.on('response', (r) => {
    if (r.status() >= 400) erreursPage.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  // Model bounds, read by the measurement harness itself: the bench poses depend on them,
  // and a second read would describe another scene.
  const bounds = await page.evaluate(
    async (options) => (await import(`${options.mesureUrl}page.ts`)).readBounds(options),
    { sdkUrl: SDK_URL, mesureUrl: MESURE_URL, manifestUrl },
  );
  // Thirty poses spread along the whole bench trajectory: the camera moves every frame.
  const total = 9 * 60;
  const poses = Array.from({ length: POSES }, (_, i) =>
    poseAt(bounds, Math.round((i * (total - 1)) / (POSES - 1))),
  );
  resultat = await page.evaluate(
    async (options) => (await import(`${options.modulesUrl}audit.js`)).auditPoses(options),
    {
      sdkUrl: SDK_URL,
      modulesUrl: MODULES_URL,
      manifestUrl,
      width: 1012,
      height: 1000,
      instances: 12,
      pixelError: 1,
      maxPages: 100000,
      warmup: 8,
      poses,
    },
  );
} finally {
  await browser.close();
  server.close();
}

console.log(JSON.stringify({ ...resultat, images: resultat.images?.slice(-3) }, null, 2));
assert.equal(resultat.erreur ?? null, null, String(resultat.erreur));
assert.deepEqual(erreursPage, [], 'the page reported errors');
assert.deepEqual(resultat.evenements, [], 'the engine reported a fallback or an error');

const t = resultat.total;
assert.equal(resultat.images.length, POSES, 'every pose must have been audited');
assert.ok(t.clusters > 0, 'no resident row was compared');
assert.equal(t.violations1, 0, `${t.violations1} GPU rectangles narrower than the reference`);
assert.equal(t.violations2, 0, `${t.violations2} boxes cut by the near plane with no clip flag`);
assert.equal(t.violations3, 0, `${t.violations3} GPU depths above the reference`);
// Activity proof: the cut does run on the GPU. Holes are proven by `held-gpu-cut.browser.ts`.
for (const image of resultat.images) {
  assert.equal(image.cpuSelectMs, null, 'the cut fell back to the CPU');
  assert.equal(image.gpuSelectionFallback, false, 'GPU selection was abandoned');
}
// Without an occlusion reject, conservativeness would prove nothing: the test must decide.
assert.ok(
  resultat.images.some(
    (image: { hizRejectedClusters?: number }) => (image.hizRejectedClusters ?? 0) > 0,
  ),
  'the Hi-Z test rejected no cluster: the proof would cover nothing',
);
// Transparent clusters take the SAME test, on the same pyramid: each one the GPU removed
// must stay rejected by the reference, on its double-precision bounds.
const occ = resultat.occultation;
assert.deepEqual(
  resultat.violationsOccultation,
  [],
  'removed transparent clusters remain visible to the reference',
);
// Without a transparent cluster in the cache, the transparent half has nothing to examine and
// says so, rather than failing or dropping the opaque half.
if (await cacheHoldsBlend(join(sceneDerived(DEFAULT_SCENE), 'native/full'))) {
  assert.ok(occ.examinees > 0, 'no transparent cluster was examined');
  assert.ok(occ.rejetees > 0, 'the transparent occlusion test rejected nothing: nothing to prove');
  assert.equal(occ.violations, 0, `${occ.violations} transparent clusters wrongly rejected`);
} else {
  assert.equal(occ.examinees, 0, 'transparent clusters were examined with none in the cache');
  console.warn('transparent clusters: not examined, the reference cache holds none');
}
const pourcent = (n: number) => ((100 * n) / t.margeTexelsCount).toFixed(2);
console.log(
  `OK: ${t.clusters} clusters audited over ${POSES} poses — 0 violations of the three rules.\n` +
    `  Rectangle: ${pourcent(t.margeParPalier[0])} % of sides identical to the reference, ` +
    `${pourcent(t.margeParPalier[1])} % within one texel, ${pourcent(t.margeParPalier[4])} % beyond ` +
    `sixteen; mean ${t.margeTexelsMoyenne?.toFixed(3)} texel, max ${t.margeTexelsMax}.\n` +
    `  Depth: mean gap ${t.ecartProfondeurMoyen?.toExponential(3)}, ` +
    `max ${t.ecartProfondeurMax.toExponential(3)}, always below the reference.\n` +
    `  Screen width < 16 texels: ${t.largeurParPalier[0]} boxes on the GPU, ` +
    `${t.largeurRefParPalier[0]} on the reference — the test keeps the same fineness.`,
);
console.log(
  `OK: ${occ.rejetees} transparent clusters removed of ${occ.examinees} examined ` +
    `(${occ.poses} poses) — 0 violations: the reference rejects them all, ` +
    `including ${occ.horsEcran} whose reference rectangle touches no pixel.`,
);
