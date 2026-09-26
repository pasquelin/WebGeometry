/** Median and 95th percentile of a window, in milliseconds. */
interface Spread {
  p50: number;
  p95: number;
}

/** What the engine's `cpuSteps()` gives: each step's spread over the window, `NaN` unmeasured. */
export interface CpuSteps {
  steps: Record<string, Spread>;
}

/** The world as far as profiling goes: its frame hooks, the engine's CPU steps and, when on,
 *  the physics' clocks (`world.physics.stats`). */
export interface ProfiledWorld<Frame = unknown> {
  onFrame(hook: (frame: Frame) => void): unknown;
  beforeFrame?(hook: (info: { delta: number; time: number }) => void): unknown;
  cpuSteps?(): CpuSteps | null;
  resetCpuSteps?(): void;
  physics?: { enabled: boolean; stats: { stepMaxMs: number } };
}

/** One second of profile, as `window.__profile` holds it; `null` where nothing was measured. */
export interface ProfileWindow {
  frames: number;
  /** Main-thread time of the animation-frame callbacks of each drawn frame. */
  frameMs: Spread | null;
  /** Time of the page's own `beforeFrame` and `onFrame` hooks in each drawn frame. */
  hooksMs: Spread | null;
  /** The engine's own CPU total of a frame (`totalMs`). */
  engineMs: Spread | null;
  /** The engine's five costliest CPU steps by p95, sums left out. */
  steps: Array<{ name: string } & Spread>;
  /** The page's `physics` CPU stage (`physicsMs`), ranked or not among the five. */
  physicsMs: Spread | null;
  /** The worker's step: the slowest fixed step of its last tick (`world.physics.stats.stepMaxMs`)
   *  as each drawn frame read it, so a slow step is never averaged away. */
  workerStepMs: Spread | null;
}

/** Engine steps that add up others: shown as the total, never ranked beside their parts. */
const SUMS = new Set(['totalMs', 'encodeSubmitMs']);

/** The p50 and p95 of a list of durations, or `null` when it is empty. */
export function spread(values: number[]): Spread | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p95: at(0.95) };
}

/** A window from the durations of its frames, the engine's CPU steps and the worker's steps
 *  read over the same second. */
export function profileWindow(
  frameMs: number[],
  hooksMs: number[],
  engine: CpuSteps | null,
  workerStepMs: number[] = [],
): ProfileWindow {
  const steps = Object.entries(engine?.steps ?? {})
    .filter(([name, { p95 }]) => !SUMS.has(name) && Number.isFinite(p95))
    .map(([name, { p50, p95 }]) => ({ name, p50, p95 }))
    .sort((a, b) => b.p95 - a.p95)
    .slice(0, 5);
  const measured = (step: Spread | undefined) =>
    step && Number.isFinite(step.p95) ? { p50: step.p50, p95: step.p95 } : null;
  return {
    frames: frameMs.length,
    frameMs: spread(frameMs),
    hooksMs: spread(hooksMs),
    engineMs: measured(engine?.steps.totalMs),
    steps,
    physicsMs: measured(engine?.steps.physicsMs),
    workerStepMs: spread(workerStepMs),
  };
}

/** What a drawn frame reads of the worker's step, `null` while the physics is off. */
export const workerStep = ({ physics }: ProfiledWorld) =>
  physics?.enabled ? physics.stats.stepMaxMs : null;

const ms = ({ p50, p95 }: Spread) => `${p50.toFixed(2)} / ${p95.toFixed(2)} ms`;

/** The corner's lines for a window, p50 / p95 each: nothing for what was not measured. */
export function profileLines(latest: ProfileWindow): [string, string][] {
  const lines: [string, string][] = [];
  if (latest.frameMs) lines.push(['CPU frame', ms(latest.frameMs)]);
  if (latest.hooksMs) lines.push(['page hooks', ms(latest.hooksMs)]);
  if (latest.engineMs) lines.push(['engine CPU', ms(latest.engineMs)]);
  for (const step of latest.steps) lines.push([step.name.replace(/Ms$/, ''), ms(step)]);
  return lines;
}

/** Whether the page asked for the profile: `?profile` in its address. */
export const profiling = () =>
  new URLSearchParams(globalThis.location?.search ?? '').has('profile');

/**
 * The frames' clock: every animation-frame callback timed, a frame's callbacks sharing one
 * timestamp, so the frame closes when the next one begins. An engine session binds
 * `requestAnimationFrame` when it opens, so the clock is wound at the kit's import under
 * `?profile`, before any world opens; a frame counts only once `drew` is set by the world.
 */
const clock = {
  frameMs: [] as number[],
  hooksMs: [] as number[],
  stepMs: [] as number[],
  stamp: -1,
  tick: 0,
  hooks: 0,
};
let drew = false,
  wound = false;
function windClock() {
  if (wound) return;
  wound = true;
  const close = () => {
    if (drew) {
      clock.frameMs.push(clock.tick);
      clock.hooksMs.push(clock.hooks);
    }
    clock.tick = clock.hooks = 0;
    drew = false;
  };
  const request = requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = (callback) =>
    request((time) => {
      if (time !== clock.stamp) {
        close();
        clock.stamp = time;
      }
      const start = performance.now();
      try {
        callback(time);
      } finally {
        clock.tick += performance.now() - start;
      }
    });
}
if (profiling()) windClock();

/**
 * Starts profiling the world: every animation-frame callback is timed, and every frame hook the
 * page adds from now on; each second, `publish` receives the window just closed, and the engine's
 * CPU-step window opens again. Hooks added before this call are not seen. What it returns stops
 * the publishing.
 */
export function startProfile<Frame>(
  world: ProfiledWorld<Frame>,
  publish: (latest: ProfileWindow) => void,
) {
  windClock();
  const timed =
    <Hook extends (...args: never[]) => void>(hook: Hook) =>
    (...args: Parameters<Hook>) => {
      const start = performance.now();
      try {
        hook(...args);
      } finally {
        clock.hooks += performance.now() - start;
      }
    };
  const onFrame = world.onFrame.bind(world),
    beforeFrame = world.beforeFrame?.bind(world);
  onFrame(() => {
    drew = true;
    const step = workerStep(world);
    if (step !== null) clock.stepMs.push(step);
  });
  world.onFrame = (hook) => onFrame(timed(hook));
  if (beforeFrame) world.beforeFrame = (hook) => beforeFrame(timed(hook));
  world.resetCpuSteps?.();
  const timer = setInterval(() => {
    const { frameMs, hooksMs, stepMs } = clock;
    const engine = world.cpuSteps?.() ?? null;
    publish(profileWindow(frameMs.splice(0), hooksMs.splice(0), engine, stepMs.splice(0)));
    world.resetCpuSteps?.();
  }, 1000);
  return () => clearInterval(timer);
}
