import { EngineError } from '../contracts/cache.ts';
import type { PhysicsOption } from './options.ts';

/**
 * `physics.json`, the physics a compiled model carries (stage `physics-cook` of the native
 * compiler, `packages/asset-compiler-rust/src/physics_cook/`). Its version is its own; the shapes it
 * names are Jolt binary state, readable only by the Jolt that wrote them: the file names that
 * commit, and a reader refuses another.
 */
const PHYSICS_FORMAT_VERSION = 2;
/** The Jolt commit the engine's physics module is built from: the pin of the submodule
 *  `packages/physics-jolt-wasm/JoltPhysics`, which the compiler's cook reads (`build.rs`). A test
 *  fails while the two differ (`physics.test.ts`). */
export const JOLT_COMMIT = 'e77f175595e64cb44218cc9d9d56fc365ad0e36a';

/** One cooked shape: a SHA-addressed object beside the manifest. */
export interface CookedTile {
  url: string;
  sha256: string;
  bytes: number;
  /** Triangles the shape holds. */
  triangles: number;
  /** Its box in the primitive's frame: min x, y, z, max x, y, z. */
  bounds: [number, number, number, number, number, number];
}

/** The collision of one compiled primitive: a DAG cut in tiles, or one height field. */
interface CookedCollider {
  kind: 'mesh' | 'heightField';
  primitive: number;
  /** The glTF material of every triangle, or `null`. */
  material: number | null;
  /** The object's DAG error the level holds, and its distance measured to the drawn level 0, at
   *  or under that tolerance. */
  tolerance: number;
  hausdorff: number;
  triangles: number;
  tiles: CookedTile[];
}

/** A collider placed by a node of the model: static ground, of the matter the node's collider
 *  declares (`KHR_physics_rigid_bodies` `physicsMaterial`), when it declares one. */
export interface CookedInstance {
  node: number;
  collider: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
  friction?: number;
  restitution?: number;
}

/** A soft body a node of the model declares (`extras.physics`, the options of `obj.physics`),
 *  cooked: its `SoftBodySharedSettings` in Jolt's binary state, already at `scale`, and placed by
 *  the node; the matter its collider declares, when it declares one, which the friction and
 *  restitution of `physics` override, as `obj.physics` overrides its material's. */
export interface CookedSoftBody extends Omit<CookedInstance, 'collider'> {
  /** The options the node declares, read by the page as `obj.physics` reads them. */
  physics: PhysicsOption;
  /** The settings object, beside the manifest. */
  settings: Omit<CookedTile, 'triangles' | 'bounds'>;
  /** Simulated vertices, what it counts against `budget.physics.softVertices`. */
  vertices: number;
  /** The gas's pressure at rest, Pa; 0 without gas. */
  pressure: number;
}

/** The motion a node declares (`KHR_physics_rigid_bodies`), as `physics.json` carries it. */
interface DeclaredMotion {
  isKinematic?: boolean;
  mass?: number;
  centerOfMass?: readonly [number, number, number];
  inertiaDiagonal?: readonly [number, number, number];
  /** The turn of the inertia's principal axes, `[x, y, z, w]`. */
  inertiaOrientation?: readonly [number, number, number, number];
  gravityFactor?: number;
}

/** A capsule's or a cylinder's sizes: `height` between its caps' centres, or its faces. */
type Rounded = { height?: number; radiusTop?: number; radiusBottom?: number };
/** A `KHR_implicit_shapes` shape, as declared: its sizes under its type's name. */
export type ImplicitShape =
  | { type: 'box'; box?: { size?: readonly [number, number, number] } }
  | { type: 'sphere'; sphere?: { radius?: number } }
  | { type: 'capsule'; capsule?: Rounded }
  | { type: 'cylinder'; cylinder?: Rounded };

/** The exact weighing of the solid a cooked hull's mesh bounds, at the body's `scale` and 1000
 *  kg/m³: its centre of mass and the inertia about it (nine, column-major), in the body's frame. */
export interface CookedMass {
  mass: number;
  centerOfMass: [number, number, number];
  inertia: number[];
}

/** A shapeless body's convex hull, cooked at unit scale in its frame: a SHA-addressed object, and
 *  a dynamic body's mass. */
type CookedHull = Omit<CookedTile, 'triangles' | 'bounds'> & {
  type: 'cooked';
  mass?: CookedMass;
};

/** A rigid body a node of the model declares, placed by it, with its collider's matter. */
export interface CookedBody extends Omit<CookedInstance, 'collider'> {
  motion: DeclaredMotion;
  shape: ImplicitShape | CookedHull;
}

/** A primitive whose collider Jolt refused: it collides with nothing, and is drawn all the same. */
interface CookRefusal {
  primitive: number;
  mesh: number;
  meshPrimitive: number;
  /** Jolt's own error. */
  reason: string;
}

/** The stage's counts, its largest tolerance and measured distance, and the refused primitives. */
interface CookReport {
  colliders: number;
  instances: number;
  unplaced: number;
  triangles: number;
  hausdorff: number;
  tolerance: number;
  refused: CookRefusal[];
  /** Soft bodies cooked, and those refused: a node and the cook's reason. */
  softBodies?: number;
  softRefused?: { node: number; reason: string }[];
  /** Declared bodies cooked, and those refused: static ground alone. */
  bodies?: number;
  bodiesRefused?: { node: number; reason: string }[];
}

/** The whole file. */
export interface CookedPhysics {
  formatVersion: number;
  jolt: string;
  stage: { name: string; version: number };
  colliders: CookedCollider[];
  instances: CookedInstance[];
  /** Absent from a file cooked before soft bodies were. */
  softBodies?: CookedSoftBody[];
  /** Absent from a file cooked before declared bodies were. */
  bodies?: CookedBody[];
  report: CookReport;
}

/**
 * Reads a `physics.json` body: another format version, or shapes cooked by another Jolt, is
 * refused by name (`PHYSICS_FORMAT`), never read as something it is not.
 */
export function readCookedPhysics(file: unknown, jolt = JOLT_COMMIT): CookedPhysics {
  const cooked = file as Partial<CookedPhysics> | null;
  if (!cooked || cooked.formatVersion !== PHYSICS_FORMAT_VERSION)
    throw new EngineError(
      'PHYSICS_FORMAT',
      `physics.json format ${cooked?.formatVersion} is not ${PHYSICS_FORMAT_VERSION}: recompile the model.`,
      { formatVersion: cooked?.formatVersion ?? null },
    );
  if (cooked.jolt !== jolt)
    throw new EngineError(
      'PHYSICS_FORMAT',
      `physics.json was cooked with Jolt ${cooked.jolt}, the engine runs ${jolt}: recompile the model.`,
      { jolt: cooked.jolt ?? null },
    );
  if (!Array.isArray(cooked.colliders) || !Array.isArray(cooked.instances))
    throw new EngineError('PHYSICS_FORMAT', 'physics.json lists no colliders or instances.');
  for (const key of ['softBodies', 'bodies'] as const)
    if (cooked[key] !== undefined && !Array.isArray(cooked[key]))
      throw new EngineError('PHYSICS_FORMAT', `physics.json ${key} is no list.`);
  return cooked as CookedPhysics;
}
