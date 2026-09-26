import { createDiagnosticChannel } from '../../diagnostic/channel.ts';
import type { BackendDiagnostic } from '../../backend/types.ts';
import { effectTargetExcess, type BudgetCanvas } from '../../residency/memoryBudget.ts';
import type { Blending } from '../../../../sdk-core/src/world/constants/index.ts';

/** The page channels open now (`diagnostic.createChannel`): every world notice reaches each. */
const listeners = new Set<(notice: BackendDiagnostic) => void>();

/** Hands every world notice to `listener` until the returned function is called. */
export function listenWorldNotices(listener: (notice: BackendDiagnostic) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A world's channel (`createWorldNotices`): what its tables folded is said there once. */
export type WorldNotices = ReturnType<typeof createWorldNotices>;

/**
 * A world's diagnostic channel (`createDiagnosticChannel`): what the world itself has to say of
 * the scene a page built, delivered off the frame to the page channels open at the time. A
 * notice is said once per world and kind, never per frame.
 */
export function createWorldNotices() {
  const channel = createDiagnosticChannel(
    (notice) => {
      for (const listener of listeners) listener(notice);
    },
    { enabled: true, detail: 'summary' },
  );
  const said = new Set<string>();
  const say = (kind: string, message: string, context: Record<string, unknown> = {}) =>
    channel.emit({ phase: kind, message, context });
  return {
    /** Says `message` under `kind`: an event the world lives through, each time. */
    say,
    /** Says `message` under `kind`, unless this world already said something of that kind. */
    once(kind: string, message: string, context: Record<string, unknown> = {}) {
      if (said.has(kind)) return;
      said.add(kind);
      say(kind, message, context);
    },
    close: () => channel.close(),
  };
}

/**
 * The tables' notice: `folded` geometry objects or materials of a content another had already
 * brought, each created on its own where one could have been shared. Said once, at the end of the
 * burst that folded them, with the count of that moment.
 */
export function noticeFolds(
  notices: WorldNotices,
  folded: { geometries: number; materials: number },
) {
  for (const [kind, count] of Object.entries(folded))
    if (count > 0)
      notices.once(
        `world-duplicate-${kind}`,
        `${count} ${kind} were created with the content of another — share one: create it ` +
          `once and give it to every mesh that wears it`,
        { kind, count },
      );
}

/**
 * Says on the world's channel by how many bytes the effect chain's targets on the `drawn` canvas
 * pass the reserve of the declared one (`effectTargetExcess`), each time that excess grows. The
 * chain still draws the whole image, at full resolution: nothing is shrunk to fit the budget.
 */
export function noticeEffectBudget(
  budget: { readonly canvas: BudgetCanvas },
  drawn: { readonly width: number; readonly height: number },
  chain: { readonly size: number },
  notices: Pick<WorldNotices, 'say'>,
) {
  let said = 0;
  // The excess of the last sizes read: a frame whose sizes did not move recomputes nothing.
  let read: { width: number; height: number; canvas: BudgetCanvas; excess: number } | undefined;
  return () => {
    const { canvas } = budget,
      { width, height } = drawn;
    if (read?.width !== width || read.height !== height || read.canvas !== canvas)
      read = { width, height, canvas, excess: effectTargetExcess(width, height, canvas) };
    const excess = chain.size ? read.excess : 0;
    if (excess <= said) {
      if (!excess) said = 0;
      return;
    }
    said = excess;
    notices.say(
      'effect-targets-over-budget',
      `effect targets over budget: ${excess} bytes past the reserve of the declared ` +
        `${canvas.width} × ${canvas.height} canvas, drawn at ${width} × ${height}`,
      { excess, width, height, declared: canvas },
    );
  };
}

/**
 * The WebGL2 composer's word (`effectsRefused`) that a frame was drawn without the effect chain,
 * a transparent surface drawn blending in `blending`, which the chain's linear target
 * cannot hold (`linearRefusal`): said once per world, as `effects-refused-blending`. WebGPU draws
 * both and never says it. Heard on every refused frame: past the first, it builds nothing.
 */
export function noticeEffectRefusal(notices: Pick<WorldNotices, 'once'>) {
  let said = false;
  return (blending: Blending) => {
    if (said) return;
    said = true;
    notices.once(
      'effects-refused-blending',
      `effect chain not drawn on WebGL2: a transparent surface blends in ${blending}, which ` +
        `the chain cannot hold; the chain comes back once no such surface is drawn`,
      { blending },
    );
  };
}

/**
 * The WebGL2 program's word (`MaterialDegraded`) that it draws a surface without physical
 * `features` it cannot draw (`physicalFeaturesLost`): said once per surface and feature, as
 * `material-degraded`, and the frame goes on. WebGPU draws them and never says it. Heard on
 * every frame that draws the surface: past the first, a known feature builds nothing.
 */
export function noticeMaterialDegraded(notices: Pick<WorldNotices, 'say'>) {
  const said = new WeakMap<object, Set<string>>();
  return (
    material: { readonly name: string; readonly family: string },
    features: readonly string[],
  ) => {
    let known = said.get(material);
    if (!known) said.set(material, (known = new Set()));
    for (const feature of features) {
      if (known.has(feature)) continue;
      known.add(feature);
      notices.say(
        'material-degraded',
        `${material.family} material "${material.name}" drawn on WebGL2 without ${feature}, ` +
          `which WebGL2 cannot draw; WebGPU draws it`,
        { material: material.name, feature },
      );
    }
  };
}
