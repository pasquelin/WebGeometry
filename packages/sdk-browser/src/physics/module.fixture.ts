import { readFile } from 'node:fs/promises';
import { Worker as NodeWorker } from 'node:worker_threads';
import {
  CAST,
  CAST_WORDS,
  DEFAULT_PHYSICS_BUDGET,
  EVENT_WORDS,
  MISS,
  type PhysicsBudget,
} from '../../../sdk-core/src/physics/index.ts';
import { HUMAN_BODY } from '../../../sdk-core/src/collision/characterSettings.ts';
import type { Ray } from '../../../sdk-core/src/world/math/volumes.ts';
import type { Object3D } from '../../../sdk-core/src/world/object/object3d.ts';
import type { createPhysicsBodies } from './bodies.ts';
import { createCharacterDriver } from './characterDriver.ts';
import { openJolt, startJolt } from './joltModule.ts';
import { physicsRaycast, type PhysicsRaycastOptions } from './raycast.ts';
import type { PhysicsSession } from './session.ts';
import { engineIdOf } from './simulatedIds.ts';
import type { JoltThreadStart, SpawnJoltThread } from './joltThreads.ts';

/** Each committed module file, compiled once for every test of the run. */
const compiled = new Map<string, Promise<WebAssembly.Module>>();

/** A committed module started for the tests: 64 bodies and 64 MB unless told otherwise. */
export async function startModule(
  budget: Partial<PhysicsBudget> = {},
  pool: { count: number; spawn: SpawnJoltThread } | null = null,
) {
  const file = pool ? './joltPhysicsThreads.wasm' : './joltPhysics.wasm';
  if (!compiled.has(file))
    compiled.set(file, readFile(new URL(file, import.meta.url)).then(WebAssembly.compile));
  const module = await compiled.get(file)!;
  const full = { ...DEFAULT_PHYSICS_BUDGET, bodies: 64, memoryBytes: 64 << 20, ...budget };
  const opened = await openJolt(module, full.memoryBytes, pool);
  const jolt = startJolt(opened, full, pool?.count ?? 1);
  /** A diagnostic count the module keeps since it started: the joints some work has visited. */
  const count = (name: string) => () => (opened.exports[name] as () => number)();
  /** By the gear linking, the step's path carry and the step's breaking (`jolt_*_visits`). */
  const visits = {
    link: count('jolt_link_visits'),
    path: count('jolt_path_visits'),
    break: count('jolt_break_visits'),
  };
  return { ...jolt, visits };
}

/** The threaded module stepped by `count` threads (Node workers); `close` stops them. */
export async function startThreaded(count: number, budget: Partial<PhysicsBudget> = {}) {
  const threads: NodeWorker[] = [];
  const loader = new URL('./joltThreads.ts', import.meta.url).href;
  const spawn = (start: JoltThreadStart) =>
    threads.push(
      new NodeWorker(
        `import(${JSON.stringify(loader)}).then((m) => m.runJoltThread(require('node:worker_threads').workerData))`,
        { eval: true, workerData: start },
      ),
    );
  const jolt = await startModule(budget, { count, spawn });
  return { jolt, threads, close: () => Promise.all(threads.map((thread) => thread.terminate())) };
}

/** A started test module. */
export type Module = Awaited<ReturnType<typeof startModule>>;

/** A box body for the ADD command: engine id `id`, a motion, its height and half size. */
export const body = (id: number, motion: number, y: number, half: number, flags = 0) => ({
  id,
  motion,
  layer: motion === 0 ? 0 : 1,
  shape: 0 as const,
  flags,
  position: [0, y, 0],
  quaternion: [0, 0, 0, 1],
  size: [half, half, half] as const,
  mass: 0,
  density: 600,
  friction: 0.5,
  restitution: 0,
  gravityScale: 1,
});

/** The last step's events: `[type, a, b, impulse]` each. */
export function events(jolt: Module) {
  const words = jolt.events(),
    floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  return Array.from({ length: words.length / EVENT_WORDS }, (_, r) => {
    const at = r * EVENT_WORDS;
    return [words[at], words[at + 1], words[at + 2], floats[at + 3]];
  });
}

/** A ray down at `x` through the module, straight: its hit words. */
export function castDown(jolt: Module, x: number) {
  const query = new Uint32Array(CAST_WORDS);
  query[0] = CAST.ray;
  query[10] = MISS;
  new Float32Array(query.buffer).set([x, 5, 0, 0, -10, 0], 1);
  return jolt.cast(query);
}

/** `world.raycast(ray, options)` asked of `jolt`, its bodies those of `bodies`: the hit named. */
export function moduleRaycast(jolt: Module, bodies: ReturnType<typeof createPhysicsBodies>) {
  const session = {
    cast: async (queries: Uint32Array) => jolt.cast(queries),
    objectOf: bodies.meshOf,
    engineIdOf: (node: Object3D) => engineIdOf(bodies, node),
    materialOf: () => -1,
  };
  return (ray: Ray, options: PhysicsRaycastOptions) =>
    physicsRaycast(session as unknown as PhysicsSession, ray, options, 1000);
}

/** The human character made standing at `feet` in `jolt`, in the one step that adds the bodies
 *  `words` writes: its driver, read once. */
export function standCharacter(jolt: Module, words: Uint32Array, feet: number[]) {
  const driver = createCharacterDriver();
  const made = driver.configure({ ...HUMAN_BODY }, feet)!;
  const all = new Uint32Array(words.length + made.length);
  all.set(words);
  all.set(made, words.length);
  jolt.step(all, 0);
  driver.read(jolt.character(), 0);
  return driver;
}
