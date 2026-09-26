import {
  ASLEEP_BIT,
  BODY_INDEX,
  GENERATION_SHIFT,
  GENERATIONS,
  MAX_CATCH_UP_STEPS,
  PHYSICS_STEP,
  POSE_WORDS,
} from '../../../sdk-core/src/physics/index.ts';
import type { Object3D } from '../../../sdk-core/src/world/object/object3d.ts';
import type { Bodied } from './bodies.ts';
import { extrapolateAll } from './extrapolate.ts';
import { createPosePlacer } from './placer.ts';

/** The bodies a tick's records name: meshes and generations by slot, and the way out of one. */
export interface PosedBodies {
  readonly meshes: readonly (Bodied | null)[];
  readonly generation: Uint8Array;
  retire(index: number): void;
}

/** Longest a tick may be drawn over, and longest a late one is extrapolated: the catch-up ceiling. */
const LONGEST_MS = MAX_CATCH_UP_STEPS * PHYSICS_STEP * 1000;

/**
 * The drawn poses of the moving bodies, between two worker ticks. Each tick's record becomes the
 * target; the start is the pose drawn when it arrived, so the image never jumps back. A tick is
 * drawn over the interval at which ticks arrive (smoothed), not over the time it simulates: a
 * worker slower than the display then shows smooth slow motion, never a pose held while it is
 * late. Past the target, a late tick is extrapolated from the bodies' velocities, for one
 * interval at most. Nothing is drawn once there: a world whose bodies all sleep sends no tick.
 *
 * Every write is a flat one (`placer.ts`): the node's position, quaternion and transform tree,
 * and the world matrix straight into the row the renderer reads; no per-body listener runs.
 */
export function createPhysicsPoses(maxBodies: number, root: Object3D) {
  const to = new Float32Array(maxBodies * 7);
  /** The bodies' last step (`ObjectPhysics._state`): what `physics.velocity` and `asleep` read. */
  const state = {
    asleep: new Uint8Array(maxBodies),
    velocity: new Float32Array(maxBodies * 6),
    stamp: new Uint32Array(maxBodies),
  };
  const { velocity, asleep: sleeping, stamp } = state;
  const moving = new Int32Array(maxBodies);
  const listed = new Uint8Array(maxBodies),
    decorative = new Uint8Array(maxBodies);
  let count = 0,
    tick = 0;
  const placer = createPosePlacer(maxBodies, root);
  const { bound, place, position, quaternion } = placer;
  let start = 0,
    span = 0,
    arrived = -1,
    /** Simulated seconds per page millisecond, for the extrapolation. */
    rate = 0,
    /** How far toward the targets the last frame drew, from the pose drawn when they came. */
    drawn = 0,
    awake = false;
  /** Whether the record at `at` holds the pose slot `index` is drawn at (the turn up to sign). */
  const unchanged = (index: number, floats: Float32Array, at: number) => {
    const p = index * 3,
      q = index * 4;
    const dot =
      quaternion[q] * floats[at + 4] +
      quaternion[q + 1] * floats[at + 5] +
      quaternion[q + 2] * floats[at + 6] +
      quaternion[q + 3] * floats[at + 7];
    return (
      position[p] === floats[at + 1] &&
      position[p + 1] === floats[at + 2] &&
      position[p + 2] === floats[at + 3] &&
      Math.abs(dot) >= 1 - 1e-6
    );
  };
  return {
    state,
    /** Every mesh keeps its own pose numbers again (the physics stops). */
    clear: placer.clear,
    /**
     * A tick's pose records arrived, simulating `ms` of the page's time; returns how many moved a
     * body from where it is drawn (a pose sent again unchanged asks for no frame). A record of a
     * body that left its slot is skipped. A decorative body that fell asleep is placed at its
     * last pose at once and retired, out of the simulation. Typed arrays only, but for a mesh
     * met for the first time in its slot.
     */
    receive(words: Uint32Array, records: number, bodies: PosedBodies, ms: number) {
      const { generation, meshes } = bodies;
      const floats = new Float32Array(words.buffer, words.byteOffset, words.length);
      const now = performance.now();
      const interval = arrived < 0 ? ms : now - arrived;
      arrived = now;
      // A first tick, or one after a rest, is drawn over the time it simulates.
      span = ms <= 0 ? 0 : interval > LONGEST_MS ? ms : span > 0 ? span * 0.7 + interval * 0.3 : ms;
      rate = span > 0 ? ms / span / 1000 : 0;
      let moved = 0;
      awake = false;
      tick++;
      placer.begin();
      for (let r = 0; r < records; r++) {
        const at = r * POSE_WORDS,
          head = words[at],
          index = head & BODY_INDEX,
          g = generation[index],
          mesh = meshes[index];
        // A body that left its slot, or a model's own (`bodySlots.ts`), draws nothing here. The
        // mesh is compared, never read: its object stays out of the cache, ten thousand a tick.
        if (g !== (head >>> GENERATION_SHIFT) % GENERATIONS || mesh === null || mesh === undefined)
          continue;
        if (bound[index] !== g) {
          placer.bind(index, g, mesh);
          decorative[index] = mesh.physics.decorative ? 1 : 0;
        }
        const asleep = (head & ASLEEP_BIT) !== 0,
          v = index * 6;
        sleeping[index] = asleep ? 1 : 0;
        stamp[index] = tick;
        // An asleep body is not extrapolated.
        const moves = asleep ? 0 : 1;
        velocity[v] = floats[at + 8] * moves;
        velocity[v + 1] = floats[at + 9] * moves;
        velocity[v + 2] = floats[at + 10] * moves;
        velocity[v + 3] = floats[at + 11] * moves;
        velocity[v + 4] = floats[at + 12] * moves;
        velocity[v + 5] = floats[at + 13] * moves;
        if (asleep && decorative[index]) {
          place(index, floats, at + 1);
          // Its generation moves on: the next frame takes it off the moving list, and a body
          // that takes the slot before then is listed once, not twice.
          bodies.retire(index);
          moved++;
          continue;
        }
        // A listed body is on its way: its record is its next target, whatever it holds.
        if (!listed[index] && unchanged(index, floats, at)) continue;
        const o = index * 7;
        moved++;
        to[o] = floats[at + 1];
        to[o + 1] = floats[at + 2];
        to[o + 2] = floats[at + 3];
        to[o + 3] = floats[at + 4];
        to[o + 4] = floats[at + 5];
        to[o + 5] = floats[at + 6];
        to[o + 6] = floats[at + 7];
        awake ||= !asleep;
        if (!listed[index]) moving[count++] = index;
        listed[index] = 1;
      }
      placer.end();
      start = now;
      drawn = 0;
      return moved;
    },
    /** Draws every moving body at this frame's point; whether any is still on its way (and asks
     *  for the next frame). */
    apply({ generation }: PosedBodies) {
      if (!count) return false;
      const elapsed = performance.now() - start;
      const alpha = span > 0 ? Math.min(1, elapsed / span) : 1;
      // Past the target, a late tick is extrapolated, for one interval at most.
      const ahead = awake ? Math.min(Math.max(0, elapsed - span), span) * rate : 0;
      // Short of the target, each frame goes the rest of the way in proportion from where the
      // last one drew: the same line from the pose drawn when the tick came, read from the node.
      const step = alpha < 1 ? (alpha - drawn) / (1 - drawn) : 1;
      drawn = alpha;
      placer.begin();
      // A slot whose body left, or went to another mesh, leaves the list: it waits for that
      // mesh's own record, which lists it again. The rest is drawn in one pass.
      let kept = 0;
      for (let i = 0; i < count; i++) {
        const index = moving[i];
        if (listed[index] && bound[index] === generation[index]) moving[kept++] = index;
        else listed[index] = 0;
      }
      count = kept;
      // Short of the target, or on it: the record itself, sent again, is then seen unchanged.
      if (alpha < 1 || ahead === 0) placer.draw(moving, count, to, alpha < 1 ? step : 1);
      else {
        extrapolateAll(moving, count, to, velocity, ahead, position, quaternion);
        placer.commit(moving, count);
      }
      placer.end();
      if (alpha < 1 || (awake && elapsed < 2 * span)) return true;
      for (let i = 0; i < count; i++) listed[moving[i]] = 0;
      count = 0;
      return false;
    },
  };
}
