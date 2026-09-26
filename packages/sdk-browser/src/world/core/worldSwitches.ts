import type { MeasuredWorld } from '../session/explorer.ts';
import type { WorldRenderer } from '../capability/worldReady.ts';
import type { WorldOptions } from './worldOptions.ts';
import { EffectChain } from '../../../../sdk-core/src/world/effect/chain.ts';
import { createGuideSet, type Guides } from '../../guides/guideSet.ts';
import { noticeEffectRefusal, type WorldNotices } from '../diagnostic/worldNotices.ts';
import type { ParticlePool } from '../../../../sdk-core/src/fluids/particles.ts';

/** What of the world's runtime the switches reach: its open session, and its reopening. */
interface SwitchedRuntime {
  readonly explorer: MeasuredWorld | null;
  renew(): void;
}

/**
 * The world's render switches — bounced light, temporal antialiasing, the effect chain — and its
 * guides: held by the world, given to every session it opens (`held`), the switches written into
 * the open one in place, the session reopened only where it cannot take one. Temporal
 * antialiasing reads back what the open session draws; before one opens, what the page asked
 * (`world.temporalAntialiasing`). The chain is shared by reference: a session reads it at every
 * frame, and says on the world's `notices` a frame it drew without it (`noticeEffectRefusal`).
 */
export function worldSwitches(
  options: WorldOptions,
  runtime: () => SwitchedRuntime,
  device: { readonly renderer: WorldRenderer | null },
  invalidate: () => void,
  notices: Pick<WorldNotices, 'once'>,
) {
  const held = {
    bounce: false,
    temporalAntialiasing: options.temporalAntialiasing !== false,
    // One chain for the world's life: every session draws it, a change asks for a frame.
    effects: new EffectChain(invalidate),
    effectsRefused: noticeEffectRefusal(notices),
    guides: createGuideSet(invalidate),
    // The particle pools the measurement entry attaches (`attachParticles`); none by default.
    particles: [] as ParticlePool[],
    particlesRefused: (reason: string) => notices.once('particles-refused', reason),
  };
  return {
    held,
    /** The page's guides: one set for the world's life, drawn by every session it opens. */
    guides: held.guides as Guides,
    get bounce() {
      return held.bounce;
    },
    set bounce(on: boolean) {
      if (on === held.bounce) return;
      held.bounce = on;
      const session = runtime().explorer;
      if (session && !session.setBounce(on)) runtime().renew();
      invalidate();
    },
    get temporalAntialiasing() {
      const session = runtime().explorer;
      if (session) return session.temporalAntialiasing();
      return held.temporalAntialiasing && device.renderer !== 'webgl2';
    },
    set temporalAntialiasing(on: boolean) {
      if (on === held.temporalAntialiasing) return;
      held.temporalAntialiasing = on;
      runtime().explorer?.setTemporalAntialiasing(on);
      invalidate();
    },
  };
}
