import { NODE_TRS_DIRTY } from '../../../sdk-core/src/math/transform-tree/transformTree.ts';
import { composeMatrix4At } from '../../../sdk-core/src/math/matrix/matrix4Compose.ts';
import { Object3D } from '../../../sdk-core/src/world/object/object3d.ts';
import type { SceneLink } from '../../../sdk-core/src/world/object/sceneLink.ts';
import type { Bodied } from './bodies.ts';

type Batch = NonNullable<ReturnType<NonNullable<SceneLink['seat']>>>['batch'];
const UNASKED = -2,
  NO_ROW = -1;

/** True when `node` sits at the origin, unturned and unscaled: its children's world is their local. */
const atRest = ({ parent, position, quaternion, scale }: Object3D) =>
  !parent &&
  position.elements.every((v) => v === 0) &&
  quaternion.elements.every((v, k) => v === (k === 3 ? 1 : 0)) &&
  scale.elements.every((v) => v === 1);

/**
 * Writes the physics' drawn poses where they are read, in flat arrays only. A bound mesh keeps its
 * position, quaternion and scale in this placer's arrays (`ObservedComponents._share`), so a write
 * here is the node's own and a page reading it sees the drawn pose; the pose also lands in the
 * transform tree every node shares, and its world matrix is composed straight into the row the
 * renderer draws it from (`SceneLink.seat`). The world hears the written span of each instance
 * buffer once per batch of writes. A body the world holds no row for, one with children, or any
 * body while the scene itself is moved, is handed to `SceneLink.posed`, which recomposes it.
 */
export function createPosePlacer(maxBodies: number, root: Object3D) {
  const position = new Float64Array(maxBodies * 3),
    quaternion = new Float64Array(maxBodies * 4),
    scale = new Float64Array(maxBodies * 3);
  /** Each slot's mesh, the generation it was bound at (-1: none) and its node in the tree. */
  const owner: (Bodied | null)[] = [],
    bound = new Int16Array(maxBodies).fill(-1),
    node = new Int32Array(maxBodies);
  const slotOf = new Map<Bodied, number>();
  /** Each slot's row (`UNASKED` until asked, `NO_ROW` when it has none or must not use it) and
   *  batch, as a rank in `batches`, whose written span is `from`..`to`. */
  const rowOf = new Int32Array(maxBodies).fill(UNASKED),
    batchOf = new Int32Array(maxBodies);
  const batches: Batch[] = [],
    matrices: Float64Array[] = [],
    from: number[] = [],
    to: number[] = [];
  /** The one transform tree every node lives in. */
  const tree = Object3D._treeOf(root);
  let epoch = NaN,
    direct = false,
    placed: Bodied[] = [];
  /** The tree's stores, read once per batch: they are replaced when the tree grows. */
  let [tp, tq, flags] = [tree.position, tree.quaternion, tree.flags];
  /** The listed slots into the tree and rows; its stores as locals, not reloaded at each use. */
  const commitAll = (list: Int32Array, count: number) => {
    const [p, q, f] = [tp, tq, flags];
    for (let i = 0; i < count; i++) commit(list[i], p, q, f);
  };
  /** Slot `index`'s pose, as its arrays hold it, into the tree's stores and its row. */
  const commit = (index: number, tp: Float64Array, tq: Float64Array, flags: Uint8Array) => {
    const p = index * 3,
      q = index * 4,
      n = node[index];
    tp[n * 3] = position[p];
    tp[n * 3 + 1] = position[p + 1];
    tp[n * 3 + 2] = position[p + 2];
    tq[n * 4] = quaternion[q];
    tq[n * 4 + 1] = quaternion[q + 1];
    tq[n * 4 + 2] = quaternion[q + 2];
    tq[n * 4 + 3] = quaternion[q + 3];
    flags[n] |= NODE_TRS_DIRTY;
    if (rowOf[index] === UNASKED) seatOf(index, owner[index]!);
    const b = batchOf[index],
      row = rowOf[index];
    if (row === NO_ROW) return void placed.push(owner[index]!);
    composeMatrix4At(matrices[b], row * 16, position, p, quaternion, q, scale, p);
    if (row < from[b]) from[b] = row;
    if (row > to[b]) to[b] = row;
  };
  const seatOf = (index: number, mesh: Bodied) => {
    const seat = direct && !mesh.children.length ? (mesh._link?.seat?.(mesh) ?? null) : null;
    rowOf[index] = NO_ROW;
    if (!seat) return;
    let rank = batches.indexOf(seat.batch);
    if (rank < 0) {
      rank = batches.push(seat.batch) - 1;
      matrices[rank] = seat.batch.rows!.matrices;
      from[rank] = Infinity;
      to[rank] = -1;
    }
    batchOf[index] = rank;
    rowOf[index] = seat.row;
  };
  /** Writes slot `index` at `pose` (7 numbers from `at`): node, tree, and row. */
  const place = (index: number, pose: ArrayLike<number>, at: number) => {
    const p = index * 3,
      q = index * 4;
    position[p] = pose[at];
    position[p + 1] = pose[at + 1];
    position[p + 2] = pose[at + 2];
    quaternion[q] = pose[at + 3];
    quaternion[q + 1] = pose[at + 4];
    quaternion[q + 2] = pose[at + 5];
    quaternion[q + 3] = pose[at + 6];
    commit(index, tp, tq, flags);
  };
  /** The mesh keeps its own numbers again, as they stand. */
  const release = (mesh: Bodied) => {
    slotOf.delete(mesh);
    mesh.position._share(new Float64Array(3));
    mesh.quaternion._share(new Float64Array(4));
    mesh.scale._share(new Float64Array(3));
  };
  return {
    position,
    quaternion,
    bound,
    /** Slot `index` holds `mesh` at `generation`: the mesh's pose numbers move here. */
    bind(index: number, generation: number, mesh: Bodied) {
      const before = owner[index];
      if (before && before !== mesh && slotOf.get(before) === index) release(before);
      const was = slotOf.get(mesh);
      if (was !== undefined && was !== index) owner[was] = null;
      slotOf.set(mesh, index);
      owner[index] = mesh;
      mesh.position._share(position.subarray(index * 3, index * 3 + 3));
      mesh.quaternion._share(quaternion.subarray(index * 4, index * 4 + 4));
      mesh.scale._share(scale.subarray(index * 3, index * 3 + 3));
      bound[index] = generation;
      node[index] = mesh.index;
      rowOf[index] = UNASKED;
    },
    /** Every mesh keeps its own numbers again (the physics stops). */
    clear() {
      for (const mesh of [...slotOf.keys()]) release(mesh);
      owner.length = 0;
      bound.fill(-1);
    },
    /** Opens a batch of writes: the rows asked before are dropped when the world moved them. */
    begin() {
      const link = root._link;
      const now = link?.seatEpoch?.() ?? NaN,
        rest = !!link?.seat && atRest(root);
      if (now !== epoch || rest !== direct) {
        rowOf.fill(UNASKED);
        batches.length = matrices.length = 0;
      }
      epoch = now;
      direct = rest;
      from.fill(Infinity);
      to.fill(-1);
      [tp, tq, flags] = [tree.position, tree.quaternion, tree.flags];
    },
    place,
    commit: commitAll,
    /**
     * Draws the `count` slots listed in `list` the fraction `step` of the way from where they are
     * drawn to their targets (7 numbers per slot in `target`, at the slot's index × 7), each turn
     * normalised and taken the shorter way round; a `step` of 1 lands on the targets exactly.
     */
    draw(list: Int32Array, count: number, target: Float32Array, step: number) {
      if (step === 1) {
        for (let i = 0; i < count; i++) place(list[i], target, list[i] * 7);
        return;
      }
      for (let i = 0; i < count; i++) {
        const index = list[i],
          o = index * 7;
        const p = index * 3,
          q = index * 4;
        position[p] += (target[o] - position[p]) * step;
        position[p + 1] += (target[o + 1] - position[p + 1]) * step;
        position[p + 2] += (target[o + 2] - position[p + 2]) * step;
        // A quaternion and its opposite are one rotation: the target on the drawn one's side.
        const dot =
          quaternion[q] * target[o + 3] +
          quaternion[q + 1] * target[o + 4] +
          quaternion[q + 2] * target[o + 5] +
          quaternion[q + 3] * target[o + 6];
        const s = dot < 0 ? -1 : 1;
        const x = quaternion[q] + (s * target[o + 3] - quaternion[q]) * step,
          y = quaternion[q + 1] + (s * target[o + 4] - quaternion[q + 1]) * step,
          z = quaternion[q + 2] + (s * target[o + 5] - quaternion[q + 2]) * step,
          w = quaternion[q + 3] + (s * target[o + 6] - quaternion[q + 3]) * step;
        const n = 1 / (Math.sqrt(x * x + y * y + z * z + w * w) || 1);
        quaternion[q] = x * n;
        quaternion[q + 1] = y * n;
        quaternion[q + 2] = z * n;
        quaternion[q + 3] = w * n;
      }
      commitAll(list, count);
    },
    /** Closes the batch: the world hears the written rows and the nodes it recomposes itself. */
    end() {
      const link = root._link;
      for (let b = 0; b < batches.length; b++)
        if (to[b] >= 0) link?.placed?.(batches[b], from[b], to[b]);
      // The list is read before the next frame, which gets a fresh one.
      if (placed.length) link?.posed(placed);
      placed = [];
    },
  };
}
