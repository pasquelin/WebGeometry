import { EngineError } from '../../../sdk-core/src/contracts/cache.ts';
import {
  BODY_INDEX,
  CAST_WORDS,
  CHARACTER_STATE_WORDS,
  EVENT_WORDS,
  HIT_WORDS,
  MODULE_ERROR,
  WATER_PIECE_WORDS,
  POSE_WORDS,
  type PhysicsBudget,
} from '../../../sdk-core/src/physics/index.ts';
import { joltImports, type SpawnJoltThread } from './joltThreads.ts';

/** The flat C API of `joltPhysics.wasm` (`packages/physics-jolt-wasm/src/world.cpp`). */
interface JoltExports {
  _initialize(): void;
  jolt_init(
    maxBodies: number,
    bodyPairs: number,
    contactConstraints: number,
    tempBytes: number,
    threads: number,
  ): number;
  jolt_buffer(which: number, words: number): number;
  jolt_step(commandWords: number, dt: number): number;
  jolt_event_count(): number;
  jolt_dropped_events(): number;
  jolt_update_error(): number;
  jolt_refused_count(): number;
  jolt_refused(i: number): number;
  jolt_error(): number;
  jolt_active_count(): number;
  jolt_owed_leaves(): number;
  jolt_water_query(top: number, sliceLength: number): number;
  jolt_water_pieces(): number;
  jolt_cast_buffer(count: number): number;
  jolt_cast(count: number): number;
  jolt_character(): number;
  jolt_broken_count(): number;
  jolt_broken(i: number): number;
  jolt_vehicles(): number;
  jolt_vehicle_words(): number;
  jolt_soft(): number;
  jolt_soft_words(): number;
}

/** Bytes of Jolt's per-step scratch allocator, taken from the memory budget. */
const TEMP_BYTES = 16 * 1024 * 1024;
const PAGE = 65536;
/** Pages the module declares as its initial memory (`-sINITIAL_MEMORY`, CMakeLists.txt). */
const INITIAL_PAGES = 512;
/** The budget each bit of `jolt_update_error` names (Jolt's `EPhysicsUpdateError`: the manifold
 *  cache is sized from both). */
const UPDATE_ERRORS = ['bodyPairs and contactConstraints', 'bodyPairs', 'contactConstraints'];

/** A module's own exports and memory, before the engine starts it: tools read these. */
export interface OpenedJolt {
  exports: WebAssembly.Exports;
  memory: WebAssembly.Memory;
}

/**
 * Instantiates the physics module in a memory whose maximum is `memoryBytes`: it cannot grow past
 * it. No emscripten glue: the module imports its memory, a growth notice and a clock, all given
 * here. With `threads`, the bytes are the threaded module's, its memory is shared, and
 * `threads.count` threads step it, this one included, the others started through `threads.spawn`
 * (`joltThreads.ts`).
 */
export async function openJolt(
  bytes: BufferSource,
  memoryBytes: number,
  threads: { count: number; spawn: SpawnJoltThread } | null,
): Promise<OpenedJolt> {
  const maximum = Math.floor(memoryBytes / PAGE);
  if (maximum < INITIAL_PAGES)
    throw new EngineError(
      'PHYSICS_BUDGET',
      `Physics budget "memoryBytes" is below the module's ${INITIAL_PAGES * PAGE} bytes.`,
    );
  const memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum, shared: !!threads });
  const module = await WebAssembly.compile(bytes);
  let exports: unknown = null;
  const imports = joltImports(memory, () => exports as never, threads && { module, ...threads });
  exports = (await WebAssembly.instantiate(module, imports)).exports;
  return { exports: exports as WebAssembly.Exports, memory };
}

/**
 * Starts an opened module for a budget's bodies, pairs and contacts, stepped by `threads` threads
 * (those it was opened with). A step that would need more than `budget.memoryBytes` fails.
 */
export function startJolt({ exports, memory }: OpenedJolt, budget: PhysicsBudget, threads = 1) {
  const jolt = exports as unknown as JoltExports;
  if (budget.bodies > BODY_INDEX)
    throw new EngineError('PHYSICS_BUDGET', `Physics budget "bodies" is above ${BODY_INDEX}.`);
  jolt._initialize();
  const { bodies, bodyPairs, contactConstraints } = budget;
  if (jolt.jolt_init(bodies, bodyPairs, contactConstraints, TEMP_BYTES, threads) !== 0)
    throw new EngineError('PHYSICS_FAILED', 'Physics: the module did not start.');
  const outOfMemory = () =>
    new EngineError('PHYSICS_BUDGET', 'Physics budget "memoryBytes" exceeded.');
  let commandWords = 1024;
  let commands = jolt.jolt_buffer(0, commandWords);
  const poses = jolt.jolt_buffer(1, bodies * POSE_WORDS);
  const events = jolt.jolt_buffer(2, budget.contactEvents * EVENT_WORDS);
  if (!commands || !poses || !events) throw outOfMemory();
  const maximum = Math.floor(budget.memoryBytes / PAGE) * PAGE;
  return {
    /** Copies `count` of `words` into the command buffer, runs them, steps `dt` seconds; returns
     *  the pose count. */
    step(words: Uint32Array | null, dt: number, count = words?.length ?? 0) {
      if (count > commandWords) {
        commands = jolt.jolt_buffer(0, count);
        if (!commands) throw outOfMemory();
        commandWords = count;
      }
      if (words) new Uint32Array(memory.buffer, commands, count).set(words.subarray(0, count));
      // The module's `uint32_t` comes back as a signed 32-bit number: -1 is its failure.
      const posed = jolt.jolt_step(count, dt) >>> 0;
      if (posed === 0xffffffff)
        throw new EngineError(
          'PHYSICS_FAILED',
          `Physics: ${MODULE_ERROR[jolt.jolt_error()] ?? 'unknown'} in a command.`,
        );
      return posed;
    },
    /** The module's pose words, valid until the next step. */
    poses: (count: number) => new Uint32Array(memory.buffer, poses, count * POSE_WORDS),
    /** The module's event words for the last step. */
    events: () => new Uint32Array(memory.buffer, events, jolt.jolt_event_count() * EVENT_WORDS),
    /** Enters the last step dropped past `budget.contactEvents`. */
    dropped: () => jolt.jolt_dropped_events(),
    /** The budgets the last step's collision ran out of, named; empty when none. */
    overflow: () => UPDATE_ERRORS.filter((_, bit) => jolt.jolt_update_error() & (1 << bit)),
    /** The engine ids of the bodies whose shape the last step refused. */
    refused: () =>
      Array.from({ length: jolt.jolt_refused_count() }, (_, i) => jolt.jolt_refused(i)),
    /** The ids of the joints the last step broke. */
    broken: () => Array.from({ length: jolt.jolt_broken_count() }, (_, i) => jolt.jolt_broken(i)),
    active: () => jolt.jolt_active_count(),
    /** The vehicles' state after the last step (`vehicleLayout.ts`), valid until the next. */
    vehicles: () => new Uint32Array(memory.buffer, jolt.jolt_vehicles(), jolt.jolt_vehicle_words()),
    /** The soft bodies the last step moved (`softLayout.ts`), valid until the next. */
    soft: () => new Uint32Array(memory.buffer, jolt.jolt_soft(), jolt.jolt_soft_words()),
    /** The pieces of the awake bodies reaching below `top`, cut past `sliceLength`
     *  (`WATER_PIECE_WORDS` each), valid until the next step. */
    water(top: number, sliceLength: number) {
      const count = jolt.jolt_water_query(top, sliceLength);
      return new Float32Array(memory.buffer, jolt.jolt_water_pieces(), count * WATER_PIECE_WORDS);
    },
    /** Answers scene queries (`CAST_WORDS` each) against the last step; a copy of their hits. */
    cast(queries: Uint32Array) {
      const count = queries.length / CAST_WORDS;
      const at = jolt.jolt_cast_buffer(count);
      if (!at) throw outOfMemory();
      new Uint32Array(memory.buffer, at, queries.length).set(queries);
      return new Uint32Array(memory.buffer, jolt.jolt_cast(count), count * HIT_WORDS).slice();
    },
    /** The character's state after the last step (`CHARACTER_STATE_WORDS`). */
    character: () => new Float32Array(memory.buffer, jolt.jolt_character(), CHARACTER_STATE_WORDS),
    /** Leaves a full event buffer held back: the next step sends them first. */
    owedLeaves: () => jolt.jolt_owed_leaves(),
    /** Whether the memory has grown to its budget: a trap then is the budget, not a fault. */
    full: () => memory.buffer.byteLength + 4 * PAGE > maximum,
  };
}

/** One running physics module (`startJolt`). */
export type JoltModule = ReturnType<typeof startJolt>;
