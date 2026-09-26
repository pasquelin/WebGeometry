import { EngineError } from '../../contracts/cache.ts';
import { IDENTITY_MATRIX4, copyMatrix4 } from '../matrix/matrix4.ts';
import { linkTransformNode } from './links.ts';

/**
 * Engine transform hierarchy, data-oriented: a node is an index into flat
 * arrays — parent, flags, position, quaternion `(x, y, z, w)`, scale, local matrix and
 * column-major world matrix. `localViews[i]` and `worldViews[i]` are sixteen-number views on
 * `local` and `world`, created at growth and never during an update: the GPU reads the
 * whole buffer, the kernel formulas read a node's view. Writes go through the setters,
 * which mark what they change. Each node lists its children, so a subtree walk never reads
 * outside the subtree (`links.ts`). A growth replaces every array: a caller rereads
 * `tree.world` or `tree.worldViews` after an add.
 */
export interface TransformTree {
  /** How many nodes fit before it grows. */ capacity: number;
  /** Indices served: every live node is under this bound. */
  end: number;
  /** Each node's parent, −1 for a root. */ parent: Int32Array;
  /** Each node's state bits. */ flags: Uint8Array;
  /** Positions, three per node. */ position: Float64Array;
  /** Rotations, four per node. */ quaternion: Float64Array;
  /** Sizes, three per node. */ scale: Float64Array;
  /** Local matrices, sixteen per node. */ local: Float64Array;
  /** World matrices, sixteen per node. */ world: Float64Array;
  /** One view per node of `local`. */ localViews: Float64Array[];
  /** One view per node of `world`. */ worldViews: Float64Array[];
  /** World-matrix recalculation count, and the parent's at the last recalculation. */
  version: Uint32Array;
  /** The parent's version each node last saw. */ seen: Uint32Array;
  /** Freed indices, reused before extending `end`. */
  free: Int32Array;
  /** How many freed indices wait. */ freeCount: number;
  /** Each node's children as a linked list, −1 for none: a subtree walk costs the subtree. */
  firstChild: Int32Array;
  /** Last child, where an attach links. */ lastChild: Int32Array;
  /** Next child of the same parent. */ nextSibling: Int32Array;
  /** Previous child of the same parent. */ previousSibling: Int32Array;
  /** Ancestor chain buffer. */ chain: Int32Array;
  /** Stamp buffer: what a traversal passes from a parent to its children. */ stamp: Uint32Array;
  /** Current traversal number. */ call: number;
}

/** `matrixAutoUpdate`: the local matrix is recomposed from position, rotation, scale. */
export const NODE_AUTO_UPDATE = 1;
/** Pose or local matrix written since the last composition. */
export const NODE_TRS_DIRTY = 2;
/** Local matrix or parent changed since the last world-matrix calculation. */
export const NODE_LOCAL_CHANGED = 4;
/** Reference `matrixWorldNeedsUpdate`, which only its update rule reads. */
export const NODE_WORLD_NEEDS_UPDATE = 8;
export const NODE_ALIVE = 16;

function views(buffer: Float64Array, capacity: number) {
  return Array.from({ length: capacity }, (_, i) => buffer.subarray(i * 16, i * 16 + 16));
}

/** A typed array of `length` entries holding `old`'s, which it outgrows: the one growth rule of
 *  the transform tree and the scene light store. */
export function grown<
  T extends Int32Array | Uint8Array | Uint32Array | Float32Array | Float64Array,
>(old: T | undefined, make: new (length: number) => T, length: number) {
  const next = new make(length);
  if (old) next.set(old);
  return next;
}

/** Grows capacity to `capacity` nodes, content kept. */
function reserve(tree: TransformTree, capacity: number) {
  tree.capacity = capacity;
  tree.parent = grown(tree.parent, Int32Array, capacity);
  tree.flags = grown(tree.flags, Uint8Array, capacity);
  tree.position = grown(tree.position, Float64Array, capacity * 3);
  tree.quaternion = grown(tree.quaternion, Float64Array, capacity * 4);
  tree.scale = grown(tree.scale, Float64Array, capacity * 3);
  tree.local = grown(tree.local, Float64Array, capacity * 16);
  tree.world = grown(tree.world, Float64Array, capacity * 16);
  tree.localViews = views(tree.local, capacity);
  tree.worldViews = views(tree.world, capacity);
  tree.version = grown(tree.version, Uint32Array, capacity);
  tree.seen = grown(tree.seen, Uint32Array, capacity);
  tree.free = grown(tree.free, Int32Array, capacity);
  tree.firstChild = grown(tree.firstChild, Int32Array, capacity);
  tree.lastChild = grown(tree.lastChild, Int32Array, capacity);
  tree.nextSibling = grown(tree.nextSibling, Int32Array, capacity);
  tree.previousSibling = grown(tree.previousSibling, Int32Array, capacity);
  tree.chain = new Int32Array(capacity);
  tree.stamp = grown(tree.stamp, Uint32Array, capacity);
}

/** An empty hierarchy, ready for `capacity` nodes without growth. */
export function createTransformTree(capacity = 64): TransformTree {
  const tree = { end: 0, freeCount: 0, call: 0 } as TransformTree;
  reserve(tree, Math.max(1, capacity));
  return tree;
}

/** Throws if `node` is not a live node of the tree. */
export function assertNode(tree: TransformTree, node: number) {
  if (!(node >= 0 && node < tree.end && tree.flags[node] & NODE_ALIVE))
    throw new EngineError('UNKNOWN_TRANSFORM_NODE', `node ${node} absent from the hierarchy`, {
      node,
    });
}

/**
 * Adds a node under `parent` (`-1` for a root) and returns its index. State of a fresh object of the
 * reference: zero position, identity rotation, scale 1, identity matrices, automatic
 * update.
 */
export function addTransformNode(tree: TransformTree, parent = -1) {
  if (parent !== -1) assertNode(tree, parent);
  let node: number;
  if (tree.freeCount) node = tree.free[--tree.freeCount];
  else {
    if (tree.end === tree.capacity) reserve(tree, tree.capacity * 2);
    node = tree.end++;
  }
  tree.parent[node] = -1;
  tree.firstChild[node] = tree.lastChild[node] = -1;
  linkTransformNode(tree, node, parent);
  tree.flags[node] = NODE_ALIVE | NODE_AUTO_UPDATE | NODE_TRS_DIRTY | NODE_LOCAL_CHANGED;
  setNodePosition(tree, node, 0, 0, 0);
  setNodeQuaternion(tree, node, 0, 0, 0, 1);
  setNodeScale(tree, node, 1, 1, 1);
  tree.localViews[node].set(IDENTITY_MATRIX4);
  tree.worldViews[node].set(IDENTITY_MATRIX4);
  tree.version[node] = 0;
  tree.seen[node] = 0;
  return node;
}

/** Moves one node of a transform tree to `(x, y, z)` from its parent. */
export function setNodePosition(
  tree: TransformTree,
  node: number,
  x: number,
  y: number,
  z: number,
) {
  const p = tree.position,
    at = node * 3;
  p[at] = x;
  p[at + 1] = y;
  p[at + 2] = z;
  tree.flags[node] |= NODE_TRS_DIRTY;
}

/** Turns one node of a transform tree to the quaternion `(x, y, z, w)`. */
export function setNodeQuaternion(
  tree: TransformTree,
  node: number,
  x: number,
  y: number,
  z: number,
  w: number,
) {
  const q = tree.quaternion,
    at = node * 4;
  q[at] = x;
  q[at + 1] = y;
  q[at + 2] = z;
  q[at + 3] = w;
  tree.flags[node] |= NODE_TRS_DIRTY;
}

/** Stretches one node of a transform tree by `(x, y, z)`. */
export function setNodeScale(tree: TransformTree, node: number, x: number, y: number, z: number) {
  const s = tree.scale,
    at = node * 3;
  s[at] = x;
  s[at + 1] = y;
  s[at + 2] = z;
  tree.flags[node] |= NODE_TRS_DIRTY;
}

/**
 * Sets the local matrix. Under automatic update, the next update recomposes it from
 * position, rotation and scale, as the reference overwrites `matrix`.
 */
export function setNodeLocalMatrix(tree: TransformTree, node: number, m: ArrayLike<number>) {
  copyMatrix4(tree.localViews[node], m);
  tree.flags[node] |= NODE_LOCAL_CHANGED | NODE_TRS_DIRTY;
}

/**
 * `matrixAutoUpdate`. Nothing else to mark when re-enabling it: a local matrix that differs from its
 * composition already carries `NODE_TRS_DIRTY`, set by `setNodeLocalMatrix` or by a pose setter.
 */
export function setNodeAutoUpdate(tree: TransformTree, node: number, auto: boolean) {
  if (auto) tree.flags[node] |= NODE_AUTO_UPDATE;
  else tree.flags[node] &= ~NODE_AUTO_UPDATE;
}
