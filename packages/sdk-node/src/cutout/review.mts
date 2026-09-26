import { basename } from 'node:path';
import type {
  CutoutModel,
  CutoutReviewOptions,
  CutoutReviewSummary,
} from '../compiler/contracts.ts';
import { answerSheet, pendingOf, readSheet, type PendingCutout, type Sheet } from './sheet.mts';
import { imageKind } from './draw.mts';
import { readThumbnails, type EmbeddedImages, type Thumbnail } from './thumb.mts';
import { askAnswer, LEGENDE, pictureOf, show } from './show.mts';

/**
 * The cutout questions of a whole batch, asked once and applied everywhere.
 *
 * A batch of one is still a batch: the same path serves a single import and nine of them. Answers
 * are keyed by the image's bytes, so a leaf shared by two scenes is shown once and answered once,
 * and the answer lands in every sheet that knows it.
 *
 * The pass asks and writes; it does NOT compile. It names the models an answer moved and hands them
 * back — the caller owns the budget, the progress line and the cancellation, and is the only one
 * able to compile them the way it compiled them the first time.
 *
 * Nobody is asked anything when the output is not a terminal: the pending textures are listed and
 * the run ends, which is what a log, a pipe or an automated chain wants.
 */
interface Loaded {
  model: CutoutModel;
  name: string;
  sheet: Sheet;
}

function nameOf(model: CutoutModel): string {
  return model.id ?? basename(model.cache);
}

/** Reads every sheet of the batch; a model with no sheet simply has nothing to answer. */
async function sheetsOf(models: CutoutModel[]): Promise<Loaded[]> {
  const read = await Promise.all(
    models.map(async (model) => ({ model, sheet: await readSheet(model.cache) })),
  );
  return read.flatMap(({ model, sheet }) => (sheet ? [{ model, name: nameOf(model), sheet }] : []));
}

/** Asks, model by model, whether each cut-out surface looks right, and records the answers. */
export async function reviewCutouts(
  models: CutoutModel[],
  options: CutoutReviewOptions = {},
): Promise<CutoutReviewSummary> {
  const stream = options.stream ?? process.stderr;
  const loaded = await sheetsOf(models);
  const pending = pendingOf(loaded);
  if (pending.length === 0) return { pending: 0, answered: 0, changed: [] };
  const named = new Set(pending.flatMap((one) => one.models));
  stream.write(`\n${pending.length} texture(s) to decide across ${named.size} model(s)\n`);
  if (!(options.interactive ?? Boolean(stream.isTTY))) {
    for (const one of pending)
      stream.write(
        `  ${basename(one.image)} · proposal ${one.proposal ? 'cutout' : 'blend'} · ${one.models.join(', ')}\n`,
      );
    stream.write('  Answer from a terminal, or edit the response sheet by hand.\n');
    return { pending: pending.length, answered: 0, changed: [] };
  }
  for (const ligne of LEGENDE) stream.write(`${ligne}\n`);
  // Only models that have something to decide are opened: the others have no image to show, and
  // their compiled product weighs tens of megabytes.
  const concerned = loaded.filter((one) => named.has(one.name));
  const answers = await ask(stream, options, concerned, pending);
  const changed = (
    await Promise.all(
      loaded.map(async (one) =>
        (await answerSheet(one.model.cache, one.sheet, answers)) ? one.model : null,
      ),
    )
  ).filter((model): model is CutoutModel => model !== null);
  const cutouts = [...answers.values()].filter(Boolean).length;
  stream.write(
    `\n  ${cutouts} cutout(s), ${answers.size - cutouts} blend(s) · ${changed.length} model(s) to recompile\n`,
  );
  return { pending: pending.length, answered: answers.size, changed };
}

/**
 * The thumbnails of the concerned models, by image: a texture two models share is read once. One
 * model at a time — each read holds a whole manifest's columns, and the questions are then asked one by
 * one anyway, so reading them all at once would only raise the peak.
 */
async function thumbnailsOf(concerned: Loaded[]): Promise<Map<string, Thumbnail>> {
  const thumbnails = new Map<string, Thumbnail>();
  for (const one of concerned)
    for (const [sha, thumbnail] of await readThumbnails(one.model.cache, one.model.scope))
      if (!thumbnails.has(sha)) thumbnails.set(sha, thumbnail);
  return thumbnails;
}

/** The pass itself: one question per texture, until an answer or a stop. */
async function ask(
  stream: NonNullable<CutoutReviewOptions['stream']>,
  options: CutoutReviewOptions,
  concerned: Loaded[],
  pending: PendingCutout[],
): Promise<Map<string, boolean>> {
  // Terminal capability is resolved once, like the stream: it does not change from one question to
  // the next, and resolving it at the bottom of the stack would hide an input decision.
  const kind = imageKind();
  const owners = new Map(concerned.map((one) => [one.name, one.model]));
  const thumbnails = await thumbnailsOf(concerned);
  const embedded: EmbeddedImages = new Map();
  const answers = new Map<string, boolean>();
  for (const [index, one] of pending.entries()) {
    const owner = owners.get(one.models[0] ?? '');
    const thumbnail = thumbnails.get(one.sha256);
    const picture = owner ? await pictureOf(owner, one, thumbnail, embedded) : null;
    await show(stream, kind, `${index + 1}/${pending.length}`, one, { thumbnail, picture });
    let answer = await askAnswer(one.proposal, options.input);
    // The reminder answers for nobody: it redisplays the rule and asks the question again.
    while (answer === 'help') {
      for (const ligne of LEGENDE) stream.write(`${ligne}\n`);
      answer = await askAnswer(one.proposal, options.input);
    }
    if (answer === 'quit') break;
    if (answer === 'rest') {
      for (const left of pending.slice(index)) answers.set(left.sha256, left.proposal);
      break;
    }
    answers.set(one.sha256, answer === 'cutout');
  }
  return answers;
}
