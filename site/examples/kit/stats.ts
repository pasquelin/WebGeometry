import { hideable, overlay } from './overlay.ts';
import { profileLines, profiling, startProfile } from './profile.ts';
import {
  STATS_CARD,
  STATS_TERM,
  STATS_VALUE,
  statsCorners,
  watchStats,
  type StatsWorld,
} from './statsLines.ts';

/**
 * A card of label and value lines in a corner of the example, at the bottom left unless `corner`
 * says otherwise; what it returns replaces its lines, a value given a class (a colour) by the
 * third item of its line.
 */
export function statsCard(corner: keyof typeof statsCorners = 'bottom-left') {
  const card = document.createElement('dl');
  card.className = `${STATS_CARD} ${statsCorners[corner]}`;
  overlay().append(card);
  hideable(card);
  return (lines: readonly (readonly [string, string, string?])[]) =>
    card.replaceChildren(
      ...lines.flatMap(([label, value, tone = '']) => {
        const term = document.createElement('dt'),
          text = document.createElement('dd');
        term.className = STATS_TERM;
        term.textContent = label;
        text.className = `${STATS_VALUE} ${tone}`;
        text.textContent = value;
        return [term, text];
      }),
    );
}

/**
 * A small corner of the example, at the bottom left unless `corner` says otherwise: the frames
 * the world drew per second, and the engine's counters of the last frame, refreshed twice a
 * second. With `?profile` in the page's address, it adds each second's CPU profile (`profile.ts`),
 * also kept as `window.__profile`. What it returns stops the corner's timers.
 */
export function stats(world: StatsWorld, corner: keyof typeof statsCorners = 'bottom-left') {
  const show = statsCard(corner);
  let profiled: [string, string][] = [];
  const stopProfile = profiling()
    ? startProfile(world, (latest) => {
        Object.assign(globalThis, { __profile: latest });
        profiled = profileLines(latest);
      })
    : () => {};
  const stopStats = watchStats(world, show, () => profiled);
  return () => {
    stopStats();
    stopProfile();
  };
}
