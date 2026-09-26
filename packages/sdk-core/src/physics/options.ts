import { EngineError } from '../contracts/cache.ts';
import type { SoftBodyOptions } from './soft.ts';

/** How a body moves: never, by the page (`kinematic`, pushing what it meets), or by the simulation. */
export type PhysicsType = 'static' | 'dynamic' | 'kinematic';

/**
 * A collision shape, when the one inferred from the geometry is not wanted. Sizes are in the
 * object's own frame, before its scale.
 */
export type PhysicsShape =
  | PhysicsPrimitive
  | { type: 'triangles' }
  | { type: 'hull' }
  /** Primitives placed in the object's frame, one rigid body: a raft of two pontoons and a deck.
   *  Its scale must be the same positive one on all three axes: never stretched nor mirrored. */
  | { type: 'compound'; parts: readonly PhysicsPart[] };

/** An exact primitive: its sizes in the object's own frame (a cylinder tapers from its top's
 *  `radius` to a `radiusBottom` that differs, as `geometry.cylinder` draws one). */
export type PhysicsPrimitive =
  | { type: 'box'; halfExtents: readonly [number, number, number] }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; halfHeight: number; radius: number }
  | { type: 'cylinder'; halfHeight: number; radius: number; radiusBottom?: number };

/** One part of a compound shape: a primitive, placed and turned in the object's frame. */
export type PhysicsPart = PhysicsPrimitive & {
  /** @defaultValue [0, 0, 0] */ position?: readonly [number, number, number];
  /** A unit quaternion `[x, y, z, w]`. @defaultValue [0, 0, 0, 1] */
  quaternion?: readonly [number, number, number, number];
};

/** What `obj.physics` accepts beyond its three words. */
export interface PhysicsBodyOptions {
  /** How the body moves. @defaultValue 'dynamic' */
  type?: PhysicsType;
  /** Mass in kilograms; left out, the material's density times the shape's volume. */
  mass?: number;
  /** The collision shape; left out, inferred from the geometry. */
  shape?: PhysicsShape;
  /** Multiplies the world's gravity for this body; 0 floats. @defaultValue 1 */
  gravityScale?: number;
  /** Reports contacts without colliding: a trigger volume. @defaultValue false */
  sensor?: boolean;
  /** Continuous collision, for fast small bodies that would pass through thin walls. @defaultValue false */
  ccd?: boolean;
  /** Debris: meets the static world only, and is simulated only in range and in view. Capped by
   *  `budget.physics.decorative`. @defaultValue false */
  decorative?: boolean;
  /** Overrides the material's friction, 0 and up. */
  friction?: number;
  /** Overrides the material's restitution (bounciness), 0 to 1. */
  restitution?: number;
  /** How much of its speed the body loses by itself, per second, as air and rolling do:
   *  `dv/dt = −c·v`, 0 and up, linear and angular apart; 0 keeps every bit. Set when the body is
   *  made: set `obj.physics` again to change it. @defaultValue { linear: 0.05, angular: 0.05 } */
  damping?: { linear?: number; angular?: number };
}

/** What `obj.physics` may be set to: a rigid body, or a soft one (`SoftBodyOptions`). */
export type PhysicsOption = PhysicsType | PhysicsBodyOptions | SoftBodyOptions;

/** Named gravities, in m/s² along −y. */
export const GRAVITY_PRESETS = {
  /** The Earth's. */ earth: 9.81,
  /** The Moon's. */ moon: 1.62,
  /** Mars's. */ mars: 3.71,
  /** No gravity. */ none: 0,
} as const;
/** A gravity preset's name. */
export type GravityPreset = keyof typeof GRAVITY_PRESETS;

/** The matter a body is made of: density (kg/m³), friction and restitution. */
export interface PhysicsMatter {
  /** kg/m³, for a body's mass. */ density: number;
  /** How much a body grips, 0 and up. */ friction: number;
  /** How much a body bounces, 0 to 1. */ restitution: number;
}

/** Named matters for `material.physics`, from handbook values rounded. */
export const PHYSICS_MATERIALS = {
  /** Wood. */ wood: { density: 600, friction: 0.5, restitution: 0.3 },
  /** Steel. */ metal: { density: 7800, friction: 0.4, restitution: 0.2 },
  /** Rubber. */ rubber: { density: 1100, friction: 0.9, restitution: 0.8 },
  /** Ice. */ ice: { density: 917, friction: 0.03, restitution: 0.05 },
  /** Stone. */ stone: { density: 2600, friction: 0.7, restitution: 0.1 },
  /** Glass. */ glass: { density: 2500, friction: 0.4, restitution: 0.4 },
} as const satisfies Record<string, PhysicsMatter>;
/** A matter preset's name. */
export type PhysicsMaterialPreset = keyof typeof PHYSICS_MATERIALS;

/** Water's density, friction and restitution: what a material that says nothing is made of. */
export const DEFAULT_MATTER: PhysicsMatter = { density: 1000, friction: 0.5, restitution: 0 };

/** The fixed envelopes of a world's physics; never read from the machine. */
export interface PhysicsBudget {
  /** Bodies of every kind at once. */
  bodies: number;
  /** Decorative bodies at once. */
  decorative: number;
  /**
   * Bytes of the physics module's memory: a hard ceiling, the module cannot grow past it. Half of
   * it holds the static collision at once: a compiled model's tiles stream within it around the
   * eye and the moving bodies, the farthest leaving first; a static triangle mesh past it is refused.
   */
  memoryBytes: number;
  /**
   * Pairs of bodies whose bounds overlap in one step. A dense pile holds about four per body; a
   * step that finds more misses contacts and raises `PHYSICS_BUDGET`.
   */
  bodyPairs: number;
  /**
   * Touching pairs solved in one step. A settled pile holds about two per body; a step that
   * finds more misses contacts and raises `PHYSICS_BUDGET`.
   */
  contactConstraints: number;
  /**
   * Contact events (`enter`, `leave`) one step reports. An `enter` past it is dropped and counted
   * (`world.physics.stats.droppedEvents`), and its `leave` is never sent; a `leave` is only delayed.
   */
  contactEvents: number;
  /**
   * Threads that step the simulation, the physics worker's included. Above 1 it needs a
   * cross-origin isolated page (shared memory); elsewhere the simulation steps on one. Never more
   * than the machine's logical cores minus the page's own.
   */
  threads: number;
  /**
   * Vertices of every soft body at once (cloths, ropes, volumes). Each one is solved every step
   * and read back to the page, 12 bytes a step.
   */
  softVertices: number;
}

/** The engine's default physics budgets. */
export const DEFAULT_PHYSICS_BUDGET: Readonly<PhysicsBudget> = Object.freeze({
  bodies: 16384,
  decorative: 1024,
  memoryBytes: 128 * 1024 * 1024,
  bodyPairs: 65536,
  contactConstraints: 32768,
  contactEvents: 4096,
  threads: 8,
  // Declared: four cloths of 64 × 64 vertices; the step's cost grows with it, linearly.
  softVertices: 16384,
});

/**
 * `budget` over the defaults, sealed: a key that is no budget — one removed, as `triangles` — is
 * refused by name, never ignored, whether passed here or added to `world.budget.physics` later.
 */
export function physicsBudgetOf(budget: Partial<PhysicsBudget> = {}): PhysicsBudget {
  for (const key of Object.keys(budget))
    if (!(key in DEFAULT_PHYSICS_BUDGET))
      throw new EngineError(
        'PHYSICS_BUDGET',
        `Physics budget "${key}" does not exist (world.budget.physics.${key}).`,
        { budget: key },
      );
  return Object.seal({ ...DEFAULT_PHYSICS_BUDGET, ...budget });
}

/** The share of `memoryBytes` the static collision holds at once. */
const COLLISION_SHARE = 0.5;
/** Bytes Jolt holds a static triangle by: what a cooked tile takes, bounding tree included. */
export const TRIANGLE_BYTES = 16;
/** Bytes of static collision `budget` holds at once: tiles and static triangle meshes together. */
export const collisionBytesOf = (budget: Pick<PhysicsBudget, 'memoryBytes'>) =>
  Math.floor(budget.memoryBytes * COLLISION_SHARE);

/** A fixed step of 60 Hz: the simulation's clock, whatever the display's rate. */
export const PHYSICS_STEP = 1 / 60;
/** Steps a late worker may take at once; beyond, the time is dropped (slow motion, never a spiral). */
export const MAX_CATCH_UP_STEPS = 4;

/** Refuses a request past a budget, naming the budget, its limit and the request. */
function physicsBudgetError(budget: keyof PhysicsBudget, limit: number, requested: number) {
  return new EngineError(
    'PHYSICS_BUDGET',
    `Physics budget "${budget}" exceeded: ${requested} asked, ${limit} allowed (world.budget.physics.${budget}).`,
    { budget, limit, requested },
  );
}

/** Refuses `requested` of `key` past its limit in `budget`; the static collision, in bytes, names
 *  the memory it is a share of. */
export function checkPhysicsBudget(
  budget: Readonly<PhysicsBudget>,
  key: 'bodies' | 'decorative' | 'softVertices' | 'collisionBytes',
  requested: number,
) {
  const collision = key === 'collisionBytes';
  const limit = collision ? collisionBytesOf(budget) : budget[key];
  if (requested > limit)
    throw physicsBudgetError(collision ? 'memoryBytes' : key, limit, requested);
}
