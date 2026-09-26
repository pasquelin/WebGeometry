import type { ProfiledWorld } from './profile.ts';
import { kitWord, labelOf, language } from './words.ts';

/** What the stats corner reads of a frame: the engine's own counters, `null` when not measured.
 *  Any other counter the frame publishes rides along under its own name (`shadowLines`). */
interface FrameCounters {
  selectedTriangles?: number | null;
  drawCalls?: number | null;
  residentPages?: number | null;
  geometryPoolBytes?: number | null;
  lightsActive?: number | null;
  gpuFrameMs?: number | null;
}

/** A node of the scene as far as counting its triangles goes. */
interface SceneNode {
  visible?: boolean;
  /** What the geometry draws: `triangles` for a mesh, points or lines otherwise. */
  primitive?: string;
  geometry?: { index?: { count: number } | null; attributes?: { position?: { count: number } } };
  traverseVisible?: (visit: (node: SceneNode) => void) => void;
}

/** The world the corner watches: its frame hook and its scene; under `?profile`, its CPU steps. */
export interface StatsWorld extends ProfiledWorld<{ metrics: FrameCounters }> {
  scene: SceneNode;
}

/** One reading of the corner: every counter measured, or `null` when it was not. */
export interface StatsSample extends FrameCounters {
  fps: number | null;
  held: boolean;
  /** True before the first sample, from a held image until the next device sample, without
   *  `timestamp-query`, or on WebGL2: `gpuFrameMs` is the last one measured. */
  gpuFrameLast?: boolean;
  sceneTriangles: number | null;
}

const count = (value: number) => Math.round(value).toLocaleString(language());
/** A duration as the kit prints it: milliseconds to two places. */
export const ms = (value: number) => `${value.toFixed(2)} ms`;

/**
 * The shadow counters of a frame, read from the names the engine publishes (`shadow…`): a
 * counter measured shows, zero included — zero is what a still scene must read —, and one the
 * engine does not hold (`null`, or absent) has no line. A duration (`…Ms`) prints in ms.
 */
export function shadowLines(frame: object): [string, string][] {
  const lines: [string, string][] = [];
  for (const [key, value] of Object.entries(frame)) {
    if (!/^shadows?[A-Z]/.test(key) || typeof value !== 'number') continue;
    if (key.endsWith('Ms')) lines.push([labelOf(key.slice(0, -2)), ms(value)]);
    else lines.push([labelOf(key), count(value)]);
  }
  return lines;
}

/**
 * The lines the corner shows, English label then value; the corner shows each label in the page's
 * language, `kit.stats.<label>` of the examples' words (`words.ts`). A counter the engine did not
 * measure has no line at all, never a dash, and no zero but a shadow counter's (`shadowLines`);
 * the triangles fall back to the scene's own count, named so, when the frame does not measure
 * them; a still image keeps its last rate, marked held, and its last GPU time, marked last.
 */
export function statLines(sample: StatsSample): [string, string][] {
  const lines: [string, string][] = [];
  if (sample.fps !== null)
    lines.push([sample.held ? 'FPS (held)' : 'FPS', String(Math.round(sample.fps))]);
  if (sample.selectedTriangles) lines.push(['triangles', count(sample.selectedTriangles)]);
  else if (sample.selectedTriangles == null && sample.sceneTriangles)
    lines.push(['triangles (scene)', count(sample.sceneTriangles)]);
  if (sample.drawCalls) lines.push(['draw calls', count(sample.drawCalls)]);
  if (sample.residentPages) lines.push(['pages', count(sample.residentPages)]);
  if (sample.geometryPoolBytes)
    lines.push(['geometry pool', `${(sample.geometryPoolBytes / 2 ** 20).toFixed(1)} MiB`]);
  if (sample.lightsActive) lines.push(['lights', count(sample.lightsActive)]);
  if (sample.gpuFrameMs != null)
    lines.push([sample.gpuFrameLast ? 'GPU frame (last)' : 'GPU frame', ms(sample.gpuFrameMs)]);
  return [...lines, ...shadowLines(sample)];
}

/** Frames a second from the times frames were drawn, in ms: `null` from fewer than two. */
export const rate = (times: readonly number[]) =>
  times.length < 2 ? null : ((times.length - 1) * 1000) / (times[times.length - 1] - times[0]);

/** Triangles of the visible meshes built in the scene: indexed, or three vertices each. Points
 *  and lines draw no triangle. */
export function sceneTriangles(scene: SceneNode): number {
  let total = 0;
  scene.traverseVisible?.((node) => {
    const shape = node.geometry;
    if (shape && (node.primitive ?? 'triangles') === 'triangles')
      total += Math.floor((shape.index?.count ?? shape.attributes?.position?.count ?? 0) / 3);
  });
  return total;
}

/** Where the corner may sit: the bottom left by default, the top left for an example whose own
 *  display takes the bottom of the frame. */
export const statsCorners = { 'bottom-left': 'bottom-3 start-3', 'top-left': 'top-3 start-3' };

/** The corner's card, and the look of its labels and values: one look for the examples' corner
 *  and the scene editor's. */
export const STATS_CARD =
  'pointer-events-none absolute grid grid-cols-[auto_auto] gap-x-3 rounded-box bg-base-100/60 px-3 py-2 font-mono text-[11px] leading-4 opacity-90 backdrop-blur';
export const STATS_TERM = 'opacity-70';
export const STATS_VALUE = 'text-end tabular-nums';

/**
 * Watches `world`: counts the frames it draws and keeps the engine's counters of the last one,
 * and twice a second hands `show` the corner's lines — `extra` added — when they changed, each
 * label in the page's language (a profiled engine step keeps its identifier). Returns what stops
 * it.
 */
export function watchStats(
  world: StatsWorld,
  show: (lines: [string, string][]) => void,
  extra: () => [string, string][] = () => [],
) {
  const drawn: number[] = [];
  let last: FrameCounters = {},
    fps: number | null = null,
    gpuFrameMs: number | null = null,
    shown = '';
  const unhook = world.onFrame(({ metrics }) => {
    drawn.push(performance.now());
    last = metrics;
    // A held image times nothing: the corner keeps the GPU time last measured.
    if (metrics.gpuFrameMs != null) gpuFrameMs = metrics.gpuFrameMs;
  });
  const timer = setInterval(() => {
    const now = performance.now();
    while (drawn.length && drawn[0] < now - 1000) drawn.shift();
    // The rate is read from the intervals between the frames of the last second; with fewer
    // than two, the image stands still and the corner keeps the rate it last read.
    const held = drawn.length < 2;
    if (!held) fps = rate(drawn);
    const sample: StatsSample = {
      ...last,
      fps,
      held: held && fps !== null,
      sceneTriangles: null,
      gpuFrameMs,
      gpuFrameLast: last.gpuFrameMs == null,
    };
    if (last.selectedTriangles == null) sample.sceneTriangles = sceneTriangles(world.scene);
    const lines = [...statLines(sample), ...extra()].map(([label, value]): [string, string] => [
        kitWord('stats', label, label),
        value,
      ]),
      key = lines.join('\n');
    if (key === shown) return;
    shown = key;
    show(lines);
  }, 500);
  return () => {
    clearInterval(timer);
    if (typeof unhook === 'function') unhook();
  };
}
