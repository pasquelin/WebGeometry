#!/usr/bin/env node
// Measurement benchmark common to all batches. One command, no server to start manually:
//   node bench/runner/bench.ts --moteur webgl --avant <ref-git|dist> --apres <ref-git|dist> \
//        --vues generale,sol,rue --images 60 --pixelError 0,1 --max-pages 100000
// All options described in `README.md`.
// Harness writes `mesure.json`, `resume.md` and one PNG per view, per threshold and per side, plus
// A/A witness capture. A field is `null` when not measured: nothing is inferred.
// Everything it launches — static server, Chromium — it stops, including on error.
// NO SERIOUS TIMING IS PROMISED HERE: harness records durations and machine load at start/end
// of each series. Caller judges if machine was quiet.
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import { launchChrome } from './chrome.ts';
import * as options from './options.ts';
import { startServer, type Capture } from '../../tests/kit/server/staticServer.ts';
import { readBounds } from './page.ts';
import { imageDiff, resume } from './summary.ts';
import { benchLights } from './lamps.ts';
import { measurementProvenance } from './report/provenance.ts';
import { recordInputs, recordCuts } from './report/evidence.ts';
import { runSerie } from './series.ts';
import { readsCache } from './scene.ts';
import { fluidsLines, runFluids } from './fluids.ts';
import { limitsLines, readLimits } from './limits.ts';
import type { Side } from './sideOptions.ts';
import type { Report, RunContext, Serie } from './report/types.ts';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const {
  settings,
  views,
  out: OUT,
  flags,
  resources,
} = options.readOptions(process.argv.slice(2), ROOT);
const CTX: RunContext = { MANIFEST: null, OUT, settings, lights: null, poses: null };

async function main() {
  await mkdir(OUT, { recursive: true });
  const rawSides = options.resolveSides({
    after: flags.get('apres'),
    before: flags.get('avant'),
    root: ROOT,
  });
  // Each side has its compiled cache (`--cache-<side>`, otherwise benchmark asset cache), engine
  // (`--moteur-<side>`, Chromium flags being union) and variant (`--variante-<side>`).
  // `--scene name` sets asset cache before equipping sides: campaign thus runs each reference scene without repeating `--cache-*` paths.
  options.applySceneFlag(flags);
  const sides = rawSides.map((side) => options.equipSide(side, flags, settings));
  const FLAGS = [...new Set(sides.flatMap((side) => side.engine.flags))];
  // Measured scene is from named caches; without any, benchmark reference scene.
  const scene = options.sceneOf(sides.find((side) => side.cache)?.cache, flags.get('scene'));
  const MANIFEST = options.assetsManifest(
    scene,
    readsCache(scene) && sides.some((side) => !side.cache),
  );
  CTX.MANIFEST = MANIFEST;
  for (const side of sides) {
    side.manifestUrl = side.cache ? `/cache/${side.name}/native/full/manifest.json` : MANIFEST;
    side.sourceUrl = side.engine.source === 'gltf' ? options.sceneGltf(scene) : null;
  }
  const captures = new Map<string, Capture>();
  const mounts = options.resolveMounts(ROOT, sides, resources);

  const report: Report = {
    startedAt: new Date().toISOString(),
    provenance: measurementProvenance(),
    campaignIdentity: process.env.TRILLION3D_CAMPAIGN_IDENTITY ?? null,
    commande: `node bench/runner/bench.ts ${process.argv.slice(2).join(' ')}`,
    head: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scene,
    engine: settings.engine,
    pathVersion: options.PATH_VERSION,
    settings,
    flags: FLAGS,
    ressources: resources,
    sides: Object.fromEntries(sides.map(options.sideReport)),
    series: [],
    errors: [],
  };

  await recordInputs(report, sides);
  const { server, port } = await startServer({
    port: settings.port,
    mounts,
    captures,
    isolation: settings.isolation,
  });
  report.settings = { ...settings, port };
  // Fresh browser per series, closed immediately after. A large scene leaves several hundred MB
  // in Chromium GPU process; closing page does not release them, causing 3rd series to fail
  // ("WebGL2 unavailable"). Relaunching browser frees GPU process between series.
  const onFreshPage = async <T>(run: (page: Page) => Promise<T>): Promise<T> => {
    const browser = await launchChrome({ headless: !settings.visible, args: FLAGS });
    report.provenance.browser = browser.version();
    const page = await browser.newPage({
      viewport: { width: settings.width, height: settings.height },
    });
    page.on('pageerror', (e) =>
      report.errors.push({ kind: 'pageerror', message: String(e.message) }),
    );
    page.on('response', (r) => {
      if (r.status() >= 400) report.errors.push({ kind: 'http', status: r.status(), url: r.url() });
    });
    page.on('console', (m) => {
      if (m.type() === 'error')
        report.errors.push({ kind: 'console', message: m.text().slice(0, 400) });
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    try {
      return await run(page);
    } finally {
      await page.close();
      await browser.close();
    }
  };
  try {
    report.limits = await onFreshPage((page) => readLimits(page, options.sdkEntryUrl(sides[0])));
    if (!readsCache(scene)) {
      report.fluids = await runFluids(sides, onFreshPage, settings, OUT, captures);
      return await publish(report, sides);
    }
    report.bounds = await onFreshPage((page) =>
      page.evaluate(readBounds, {
        sdkUrl: options.sdkEntryUrl(sides[0]),
        manifestUrl: sides[0].manifestUrl ?? MANIFEST,
      }),
    );
    const bounds = report.bounds;
    // Lights once bounds are known: geometric rule, no named scene.
    CTX.lights = benchLights(bounds, settings);
    report.lampes = CTX.lights ? CTX.lights.resume : null;
    for (const pixelError of settings.pixelErrors)
      for (const view of views) {
        const index = options.VIEWS[view].index;
        const pose = options.poseAt(bounds, index);
        // Moving camera: one pose per measured frame along benchmark trajectory.
        CTX.poses = settings.movingCamera
          ? Array.from({ length: settings.frames }, (_, i) => options.poseAt(bounds, index + i))
          : null;
        const serie: Serie = {
          view,
          pixelError,
          segment: options.VIEWS[view].segment,
          index,
          pose,
          sides: {},
        };
        report.series.push(serie);
        const files: Record<string, string> = {};
        for (const side of sides) {
          const { row, captureFile } = await onFreshPage((page) =>
            runSerie(CTX, page, side, view, pixelError, pose, captures),
          );
          serie.sides[side.name] = row;
          files[side.name] = captureFile;
        }
        // A/A witness: same side run twice, compared with itself. Shows what zero is.
        const temoin = await onFreshPage((page) =>
          runSerie(CTX, page, sides[0], view, pixelError, pose, captures, '-aa'),
        );
        serie.sides[`${sides[0].name}-aa`] = temoin.row;
        serie.temoinAA = imageDiff(
          captures.get(files[sides[0].name]),
          captures.get(temoin.captureFile),
        );
        serie.ecartAvantApres = files.avant
          ? imageDiff(captures.get(files.avant), captures.get(files.apres))
          : null;
        const avant = serie.sides.avant,
          apres = serie.sides.apres;
        serie.coupeIdentique =
          avant && apres ? avant.selection.sha256 === apres.selection.sha256 : null;
      }
  } finally {
    await new Promise((done) => server.close(done));
  }
  await publish(report, sides);
}

/** Writes `mesure.json` and `resume.md`, and says where. */
async function publish(report: Report, sides: Side[]) {
  report.finishedAt = new Date().toISOString();
  await recordCuts(report, sides, OUT);
  await writeFile(join(OUT, 'mesure.json'), JSON.stringify(report, null, 1));
  const appendix = [...limitsLines(report.limits), ...fluidsLines(report.fluids)];
  await writeFile(join(OUT, 'resume.md'), [resume(report), ...appendix].join('\n'));
  process.stdout.write(`\nJSON: ${join(OUT, 'mesure.json')}\nSummary: ${join(OUT, 'resume.md')}\n`);
  if (report.errors.length) {
    process.stdout.write(`${report.errors.length} page error(s) recorded in the JSON\n`);
    process.exitCode = 1;
  }
}

await main().catch((error) => {
  process.stderr.write(String((error && error.stack) || error) + '\n');
  process.exitCode = 1;
});
