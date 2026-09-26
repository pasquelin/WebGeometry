import type { EngineError } from '../../../sdk-core/src/contracts/cache.ts';
import {
  BODY_INDEX,
  FLAG,
  LAYER,
  MOTION,
  declaredMass,
  declaredShape,
  physicsMatterOf,
  type CommandWriter,
  type CookedBody,
  type CookedPhysics,
  TRIANGLE_BYTES,
} from '../../../sdk-core/src/physics/index.ts';
import type { createPhysicsBodies } from './bodies.ts';
import type { SlotOwner } from './bodySlots.ts';
import { createCookedSoftBodies } from './cookedSoft.ts';
import { fits } from './softBodies.ts';
import { cookedBytes, tilePose, type Model } from './tilePlace.ts';

/**
 * Whether a compiled model's nodes can be drawn moving (#432). Until they can, a dynamic body a
 * model declares is held: made kinematic at the pose its node is drawn at, so its collider never
 * leaves the node. #432 flips it, a held body then made dynamic; its poses, which the page drops
 * for a slot no mesh holds (`poses.ts`), then move its node, and it loads tiles as a mover does
 * (`moversOf`).
 */
const COMPILED_NODES_MOVE = false;

/** A declared body made: its entry, its hull's bytes, the world scale it was made at, its id. */
export type CookedMadeBody = { body: CookedBody; bytes?: Uint8Array; scale: number[]; id: number };

/**
 * The rigid bodies the compiled models in a scene declare (`physics.json` `bodies`), each one a
 * body of its model's (`bodySlots.ts`): its declared shape in Jolt's terms, or its cooked hull
 * fetched and restored — nothing built on the page —, with its declared mass over its cooked one
 * (`declaredMass`), counted against `budget.physics`. A kinematic body follows its model as any
 * kinematic body; a dynamic one is held until `release` (`COMPILED_NODES_MOVE`). A body made, its
 * node's static instances leave (`holds`): no collider is doubled.
 */
export function createCookedBodies(
  writer: CommandWriter,
  bodies: Pick<ReturnType<typeof createPhysicsBodies>, 'claim' | 'release'>,
  invalidate: () => void,
  failed: (error: EngineError) => void,
  release = COMPILED_NODES_MOVE,
) {
  /** Each open model's opening: its bodies made, the nodes whose body is made or on its way —
   *  their static tiles unwanted —, each hull read once by URL (bodies drawing one mesh share
   *  it), and the signal its leaving aborts its reads by. */
  type Opening = {
    made: CookedMadeBody[];
    nodes: Set<number>;
    hulls: Map<string, Promise<Uint8Array>>;
    signal: AbortSignal;
  };
  const held = new Map<Model, Opening>();
  const dynamic = (body: CookedBody) => release && !body.motion.isKinematic;
  /** `body` made where its model places it now, from its hull's `bytes`; throws, nothing held,
   *  for a shape the scale bends or a body past the budget. */
  function make(model: Model, body: CookedBody, bytes?: Uint8Array) {
    const { position, quaternion, scale } = tilePose({ model, instance: body });
    const resolved = declaredShape(body, scale);
    const made: CookedMadeBody = { body, bytes, scale: [scale.x, scale.y, scale.z], id: -1 };
    made.id = bodies.claim(resolved.triangles * TRIANGLE_BYTES, 0, { model, body: made });
    const handle = made.id & BODY_INDEX;
    const matter = physicsMatterOf(body);
    const moving = dynamic(body);
    if (bytes) writer.restore(handle, bytes);
    writer.add({
      ...{ id: made.id, motion: moving ? MOTION.dynamic : MOTION.kinematic },
      ...{ layer: LAYER.moving, shape: resolved.shape, position, quaternion },
      // Held or kinematic, it is added asleep: it stands still until its model moves it.
      flags: moving ? 0 : FLAG.asleep,
      ...{ size: resolved.size, ...declaredMass(body, scale), density: matter.density },
      ...{ friction: matter.friction, restitution: matter.restitution },
      ...{ gravityScale: body.motion.gravityFactor ?? 1, indices: bytes && [handle] },
    });
    if (bytes) writer.release(handle);
    invalidate();
    return made;
  }
  async function add(model: Model, opening: Opening, body: CookedBody) {
    const { shape } = body,
      { hulls, signal } = opening;
    const url = shape.type === 'cooked' ? shape.url : '';
    if (url && !hulls.has(url)) hulls.set(url, cookedBytes(model, url, signal));
    const bytes = url ? await hulls.get(url) : undefined;
    // Forgotten or opened again meanwhile: this opening's bodies are no longer wanted.
    if (held.get(model) === opening) opening.made.push(make(model, body, bytes));
  }
  /** `body` refused — but for a read its model let go of —: reported, its node static ground
   *  again. */
  const refuse = (opening: Opening, body: CookedBody, error: unknown) => {
    if (opening.signal.aborted) return;
    opening.nodes.delete(body.node);
    failed(error as EngineError);
  };
  const start = (model: Model, opening: Opening, body: CookedBody) =>
    void add(model, opening, body).catch((error) => refuse(opening, body, error));
  const forget = (model: Model) => {
    const opening = held.get(model);
    held.delete(model);
    opening?.made.forEach(({ id }) => bodies.release(id & BODY_INDEX));
  };
  return {
    /** Makes the bodies `model` declares, read until `signal` aborts, the last opening's out. */
    open(model: Model, declared: readonly CookedBody[], signal: AbortSignal) {
      forget(model);
      const nodes = new Set(declared.map((body) => body.node));
      const opening: Opening = { made: [], nodes, hulls: new Map(), signal };
      held.set(model, opening);
      for (const body of declared) start(model, opening, body);
    },
    /** A model left the scene, or physics turned off: its bodies out. */
    forget,
    /** Whether node `node` of `model` has its body, made or on its way: its tiles then leave. */
    holds: (model: Model, node: number) => held.get(model)?.nodes.has(node) ?? false,
    /** A model moved: its bodies follow — a kinematic one driven there, pushing what it meets —;
     *  one rescaled is made again at once at its new scale, Jolt scaling no body once made. The
     *  list is compacted in place: a model moved every frame makes no new one. */
    moved(model: Model) {
      const opening = held.get(model);
      if (!opening) return;
      const { made } = opening;
      let kept = 0;
      for (const one of made) {
        const { position, quaternion, scale } = tilePose({ model, instance: one.body });
        const slot = one.id & BODY_INDEX;
        if (!fits(scale, one.scale)) {
          bodies.release(slot);
          try {
            made[kept] = make(model, one.body, one.bytes);
            kept++;
          } catch (error) {
            refuse(opening, one.body, error);
          }
          continue;
        }
        if (dynamic(one.body)) writer.teleport(slot, position, quaternion);
        else writer.moveKinematic(slot, position, quaternion);
        made[kept++] = one;
      }
      made.length = kept;
    },
    /** The worker refused `body`'s shape: out, its node static ground again, until its model
     *  opens again. */
    refused({ model, body }: { model: Model; body: CookedMadeBody }) {
      const opening = held.get(model);
      const at = opening?.made.indexOf(body) ?? -1;
      if (at < 0) return;
      opening!.made.splice(at, 1);
      opening!.nodes.delete(body.body.node);
      bodies.release(body.id & BODY_INDEX);
    },
  };
}

/** The bodies the compiled models in a scene declare, soft (`cookedSoft.ts`) and rigid, opened,
 *  moved, refused and forgotten together, each by its model. */
export function createModelBodies(
  writer: CommandWriter,
  bodies: Pick<ReturnType<typeof createPhysicsBodies>, 'claim' | 'release'>,
  invalidate: () => void,
  failed: (error: EngineError) => void,
) {
  const softs = createCookedSoftBodies(writer, bodies, invalidate, failed);
  const rigid = createCookedBodies(writer, bodies, invalidate, failed);
  const both = [softs, rigid];
  return {
    /** Makes the bodies `model` was `cooked` with, read until `signal` aborts. */
    open(model: Model, cooked: CookedPhysics, signal: AbortSignal) {
      softs.open(model, cooked.softBodies ?? [], signal);
      rigid.open(model, cooked.bodies ?? [], signal);
    },
    forget: (model: Model) => both.forEach((kind) => kind.forget(model)),
    moved: (model: Model) => both.forEach((kind) => kind.moved(model)),
    holds: rigid.holds,
    /** The worker refused the body `owner` holds: one of these leaves; any other is ignored. */
    refused(owner: SlotOwner) {
      if ('soft' in owner) softs.refused(owner);
      else if ('body' in owner) rigid.refused(owner);
    },
  };
}
