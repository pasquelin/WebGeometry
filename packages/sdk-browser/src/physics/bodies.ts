import { EngineError } from '../../../sdk-core/src/contracts/cache.ts';
import {
  BODY_INDEX,
  type ObjectPhysics,
  FLAG,
  LAYER,
  MOTION,
  checkPhysicsBudget,
  physicsMatterOf,
  isSoftType,
  resolveShape,
  TRIANGLE_BYTES,
  type CommandWriter,
  type PhysicsBudget,
  type PhysicsHost,
} from '../../../sdk-core/src/physics/index.ts';
import type { Mesh } from '../../../sdk-core/src/world/object/mesh.ts';
import type { Object3D } from '../../../sdk-core/src/world/object/object3d.ts';
import { worldPoseOf, worldScaleOf } from './bodyFrame.ts';
import { addSoftBody, fits } from './softBodies.ts';
import { createBodySlots, type SlotOwner } from './bodySlots.ts';

/** A mesh the simulation holds a body for. */
export type Bodied = Mesh & { physics: NonNullable<Mesh['physics']> };

/** Whether `node` is a mesh with physics set. */
export const hasBody = (node: Object3D): node is Bodied =>
  (node as { physics?: unknown }).physics != null;

/** A body's flag bits as its settings ask; a hidden mesh sends no pose. */
export function flagsOf(mesh: Pick<Bodied, 'physics' | 'visible'>) {
  const p = mesh.physics;
  return (
    (p.sensor ? FLAG.sensor : 0) |
    (p.ccd ? FLAG.ccd : 0) |
    (p.listens ? FLAG.events : 0) |
    (mesh.visible ? 0 : FLAG.hidden)
  );
}

/**
 * The bodies of a world, by slot: which mesh holds each, and what they count against the budget.
 * Adding and removing write commands; nothing reaches the worker before the frame's flush.
 */
export function createPhysicsBodies(
  writer: CommandWriter,
  budget: Readonly<PhysicsBudget>,
  host: PhysicsHost,
  root: Object3D,
  state: NonNullable<ObjectPhysics['_state']>,
) {
  const slots = createBodySlots(budget.bodies);
  const { meshes, physicsAt } = slots;
  /** What each slot's body counts against the budget beyond itself; a soft body's vertex map. */
  const claimed = new Map<number, { bytes: number; softVertices: number }>();
  const softMaps: (Uint32Array | null)[] = [];
  const count = { bodies: 0, decorative: 0, collisionBytes: 0, softVertices: 0 };
  /** Bodies taken out: asleep decorative or refused ones (`null`), their mesh left where it came
   *  to rest; soft ones placed at another scale than the one they were made at, kept. */
  const retired = new WeakMap<Bodied['physics'], readonly number[] | null>();
  /** Whether `mesh`'s soft body, taken out at another scale, is back at the one it was made at. */
  const back = (mesh: Bodied) => {
    const scale = retired.get(mesh.physics);
    return !!scale && fits(worldScaleOf(mesh), scale);
  };
  const check = (key: keyof typeof count, more: number) =>
    checkPhysicsBudget(budget, key, count[key] + more);
  const add = (mesh: Bodied) => {
    const p = mesh.physics;
    if (p._host) return;
    if (p.type !== 'static' && p.type !== 'kinematic' && mesh.parent !== root)
      throw new EngineError(
        'PHYSICS_NESTED',
        'A dynamic or soft body must be a direct child of the scene: the simulation owns its world pose.',
        { name: mesh.name },
      );
    check('bodies', 1);
    if (p.decorative) check('decorative', 1);
    // The world pose as the transform tree composes it.
    const pose = worldPoseOf(mesh),
      size = worldScaleOf(mesh);
    const owner: SlotOwner = { mesh, physics: p };
    if (isSoftType(p.type)) {
      owner.scale = [size.x, size.y, size.z];
      const take = (bytes: number, vertices: number) => claim(bytes, vertices, owner);
      return hold(mesh, addSoftBody(writer, mesh, pose, size, take, softMaps, flagsOf(mesh)));
    }
    const matter = physicsMatterOf(mesh.material);
    const shape = resolveShape(mesh.geometry, size, p.type, p.shape, mesh.name);
    const id = claim(shape.triangles * TRIANGLE_BYTES, 0, owner);
    writer.add({
      id,
      motion: MOTION[p.type],
      layer: p.type === 'static' ? LAYER.static : p.decorative ? LAYER.decorative : LAYER.moving,
      shape: shape.shape,
      flags: flagsOf(mesh),
      position: pose.position,
      quaternion: pose.quaternion,
      size: shape.size,
      mass: p.mass ?? 0,
      density: matter.density,
      friction: p.friction ?? matter.friction,
      restitution: p.restitution ?? matter.restitution,
      gravityScale: p.gravityScale,
      damping: [p.damping.linear, p.damping.angular],
      vertices: shape.vertices,
      indices: shape.indices,
      parts: shape.parts,
    });
    hold(mesh, id & BODY_INDEX);
  };
  /** A slot's body made: the mesh that holds it. */
  const hold = (mesh: Bodied, index: number) => {
    const p = mesh.physics;
    if (p.decorative) count.decorative++;
    p._attach(host, index, state);
  };
  /** A slot held by `owner` and its engine id, counted against the budget with `bytes` bytes of
   *  static collision and `softVertices` soft-body vertices. */
  const claim = (bytes: number, softVertices: number, owner: SlotOwner) => {
    check('bodies', 1);
    check('collisionBytes', bytes);
    check('softVertices', softVertices);
    const id = slots.take(owner);
    count.bodies++;
    if (bytes || softVertices) claimed.set(id & BODY_INDEX, { bytes, softVertices });
    count.collisionBytes += bytes;
    count.softVertices += softVertices;
    return id;
  };
  /** A slot's body removed, and the slot freed for the next. */
  const release = (index: number) => {
    writer.remove(index);
    slots.release(index);
    count.bodies--;
    count.collisionBytes -= claimed.get(index)?.bytes ?? 0;
    count.softVertices -= claimed.get(index)?.softVertices ?? 0;
    claimed.delete(index);
    softMaps[index] = null;
  };
  const removeAt = (index: number) => {
    const p = physicsAt(index);
    if (!p) return;
    release(index);
    if (p.decorative) count.decorative--;
    p._detach();
  };
  return {
    meshes,
    generation: slots.generation,
    count,
    add,
    removeAt,
    /** The mesh an engine id names, or `null` once that body left its slot. */
    meshOf: slots.meshOf,
    /** Who holds each slot, by engine id (`createBodySlots`). */
    slots,
    /** Each geometry vertex's simulated vertex, for the soft body in slot `index`. */
    softMap: (index: number) => softMaps[index] ?? null,
    /** A body no mesh holds — a cooked tile or soft body (`tiles.ts`) —: its slot, then its
     *  removal. */
    claim,
    release,
    /** A body asleep decorative or refused: out of the simulation and budget until its `physics`
     *  is set again; a soft body placed off `scale`, the one it was made at, until back at it. */
    retire(index: number, scale: readonly number[] | null = null) {
      const p = physicsAt(index);
      removeAt(index);
      if (p) retired.set(p, scale);
    },
    back,
    /**
     * Brings the bodies in line with the scene, once per frame that changed it: a body whose mesh
     * left the scene, whose `physics` was replaced or whose shape or matter changed (`stale`) is
     * removed; every mesh under the scene with physics and no body gets one. A request past a
     * budget is refused and handed to `refused`, the other bodies proceed.
     */
    reconcile(stale: ReadonlySet<Object3D>, refused: (error: unknown) => void) {
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        if (mesh && (!mesh._link || mesh.physics !== physicsAt(i) || stale.has(mesh))) removeAt(i);
      }
      root.traverse((node) => {
        if (!hasBody(node) || node.physics._host) return;
        if (retired.has(node.physics) && !back(node)) return;
        retired.delete(node.physics);
        try {
          add(node);
        } catch (error) {
          refused(error);
        }
      });
    },
    /** Every body the world holds, removed (physics turned off or the world disposed). */
    clear() {
      for (let i = 0; i < meshes.length; i++) removeAt(i);
    },
  };
}
