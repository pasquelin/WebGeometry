import { readFile } from 'node:fs/promises';
import { DEFAULT_PHYSICS_BUDGET, POSE_WORDS } from '../../../sdk-core/src/physics/index.ts';
import { Camera } from '../../../sdk-core/src/world/camera/camera.ts';
import { Group } from '../../../sdk-core/src/world/object/object3d.ts';
import {
  PHYSICS_PROTOCOL,
  resultWords,
  type FromPhysics,
  type PhysicsResults,
  type ToPhysics,
} from './protocol.ts';
import { createWorldPhysics } from './worldPhysics.ts';

/** A physics worker faked in place of `Worker`: it keeps the command words the page sends it. */
interface FakeWorker {
  onmessage(event: { data: unknown }): void;
  words: Uint32Array[];
}

/** Replaces `Worker` with fakes, each listed in `workers`; `restore` puts the real one back. */
export function fakeWorkers() {
  const workers: FakeWorker[] = [];
  const saved = globalThis.Worker;
  globalThis.Worker = class {
    words: Uint32Array[] = [];
    onmessage = (_: { data: unknown }) => {};
    constructor() {
      workers.push(this);
    }
    postMessage(message: { type: string; words?: Uint32Array }) {
      if (message.words) this.words.push(message.words);
    }
    terminate() {}
  } as unknown as typeof Worker;
  return { workers, restore: () => void (globalThis.Worker = saved) };
}

/** The session's code, fetched on the first use (`worldPhysics.ts`), has been loaded. */
export const loaded = () =>
  import('./session.ts').then(() => new Promise((done) => setTimeout(done, 0)));

/** A tick from the worker that moves nothing; a test spreads what it sends over it. */
export const idleTick: PhysicsResults = {
  ...{ type: 'results', buffer: new ArrayBuffer(0), poses: 0, events: 0, dropped: 0, steps: 0 },
  ...{ seconds: 0, water: 0, waterEpoch: 0, stepMs: 0, stepMaxMs: 0, active: 0 },
  ...{ character: null, vehicles: null, soft: null },
};

/** One pose record for engine id `id`: position and quaternion, velocities zero. */
export function poseRecord(id: number, pose: number[]) {
  const words = new Uint32Array(POSE_WORDS);
  words[0] = id;
  new Float32Array(words.buffer).set(pose, 1);
  return words;
}

/** A scene and its world physics on a fake worker, the session loaded and the worker ready;
 *  `restore` puts the real `Worker` back. */
export async function fakePhysicsWorld() {
  const { workers, restore } = fakeWorkers();
  const scene = new Group();
  const runtime = { invalidate() {}, explorer: null };
  const physics = createWorldPhysics(runtime, scene, () => new Camera('perspective'), true);
  await loaded();
  const [worker] = workers;
  worker.onmessage({ data: { type: 'ready' } });
  return { scene, physics, worker, restore };
}

/**
 * The physics worker's own code run in this thread on `clock`, started on an 8-body budget and
 * ready: its ticks wait in `ticks` (with the delay asked) until the test runs them, and its results
 * are kept in `sent`, each buffer copied as it was sent. The globals it replaces stay replaced.
 */
export async function startedWorker(clock: () => number) {
  Object.defineProperty(performance, 'now', { value: clock, configurable: true });
  const scope = globalThis as unknown as Record<string, unknown>;
  const bytes = await readFile(new URL('./joltPhysics.wasm', import.meta.url));
  scope.fetch = async () => new Response(bytes);
  scope.location = { href: import.meta.url };
  const ticks: [() => void, number][] = [];
  const sent: FromPhysics[] = [];
  let onReady = () => {};
  const ready = new Promise<void>((resolve) => (onReady = resolve));
  scope.postMessage = (message: FromPhysics) => {
    sent.push(
      message.type === 'results' ? { ...message, buffer: message.buffer.slice(0) } : message,
    );
    if (message.type === 'ready') {
      scope.setTimeout = (tick: () => void, ms: number) => ticks.push([tick, ms]);
      onReady();
    }
  };
  await import('./physicsWorker.ts');
  const receive = (data: ToPhysics) =>
    (scope.onmessage as (event: { data: ToPhysics }) => void)({ data });
  const budget = { ...DEFAULT_PHYSICS_BUDGET, bodies: 8, memoryBytes: 64 << 20 };
  const buffers = [0, 1].map(() => new ArrayBuffer(resultWords(budget) * 4));
  receive({ type: 'start', protocol: PHYSICS_PROTOCOL, wasm: 'x', budget, threads: 1, buffers });
  await ready;
  return { ticks, sent, receive, budget };
}
