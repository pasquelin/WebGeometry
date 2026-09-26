/**
 * The drawn poses of the listed slots, written into `position` (3 numbers a slot) and `quaternion`
 * (4 a slot) toward their targets (`target`, 7 a slot), before the placer commits them. Each turn
 * is normalised; the arithmetic is the drawn image's, so none of it may be reordered.
 */

/** The turn (x, y, z, w) scaled to unit length, into `quaternion` from `q`. */
function normalised(
  quaternion: Float64Array,
  q: number,
  x: number,
  y: number,
  z: number,
  w: number,
) {
  const n = 1 / (Math.sqrt(x * x + y * y + z * z + w * w) || 1);
  quaternion[q] = x * n;
  quaternion[q + 1] = y * n;
  quaternion[q + 2] = z * n;
  quaternion[q + 3] = w * n;
}

/** The `count` slots listed in `list` on their targets exactly. */
export function landAll(
  list: Int32Array,
  count: number,
  target: Float32Array,
  position: Float64Array,
  quaternion: Float64Array,
) {
  for (let i = 0; i < count; i++) {
    const index = list[i];
    for (let k = 0; k < 3; k++) position[index * 3 + k] = target[index * 7 + k];
    for (let k = 0; k < 4; k++) quaternion[index * 4 + k] = target[index * 7 + 3 + k];
  }
}

/** The `count` slots listed in `list` the fraction `step` of the way from where they are drawn to
 *  their targets, each turn taken the shorter way round. */
export function interpolateAll(
  list: Int32Array,
  count: number,
  target: Float32Array,
  step: number,
  position: Float64Array,
  quaternion: Float64Array,
) {
  for (let i = 0; i < count; i++) {
    const index = list[i],
      o = index * 7,
      p = index * 3,
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
    normalised(quaternion, q, x, y, z, w);
  }
}

/** The `count` slots listed in `list` moved on from their targets by `ahead` simulated seconds
 *  of their velocities (`velocity`, 6 numbers a slot: linear, then angular). */
export function extrapolateAll(
  list: Int32Array,
  count: number,
  target: Float32Array,
  velocity: Float32Array,
  ahead: number,
  position: Float64Array,
  quaternion: Float64Array,
) {
  const h = ahead / 2;
  for (let i = 0; i < count; i++) {
    const index = list[i],
      o = index * 7,
      v = index * 6,
      p = index * 3,
      q = index * 4;
    for (let k = 0; k < 3; k++) position[p + k] = target[o + k] + velocity[v + k] * ahead;
    // The turn at angular velocity ω over `ahead`: q += ½ (ω, 0) ⊗ q · ahead.
    const wx = velocity[v + 3],
      wy = velocity[v + 4],
      wz = velocity[v + 5];
    const tx = target[o + 3],
      ty = target[o + 4],
      tz = target[o + 5],
      tw = target[o + 6];
    const x = tx + h * (wx * tw + wy * tz - wz * ty),
      y = ty + h * (wy * tw + wz * tx - wx * tz),
      z = tz + h * (wz * tw + wx * ty - wy * tx),
      w = tw - h * (wx * tx + wy * ty + wz * tz);
    normalised(quaternion, q, x, y, z, w);
  }
}
