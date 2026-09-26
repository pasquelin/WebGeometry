/**
 * The pose at `target[o]` moved on by `ahead` simulated seconds of the velocities at `velocity[v]`
 * (linear, then angular), into `pose`; its quaternion is left for the caller to normalise.
 */
export function extrapolate(
  pose: Float64Array,
  target: Float32Array,
  o: number,
  velocity: Float32Array,
  v: number,
  ahead: number,
) {
  for (let k = 0; k < 3; k++) pose[k] = target[o + k] + velocity[v + k] * ahead;
  // The turn at angular velocity ω over `ahead`: q += ½ (ω, 0) ⊗ q · ahead.
  const wx = velocity[v + 3],
    wy = velocity[v + 4],
    wz = velocity[v + 5];
  const x = target[o + 3],
    y = target[o + 4],
    z = target[o + 5],
    w = target[o + 6],
    h = ahead / 2;
  pose[3] = x + h * (wx * w + wy * z - wz * y);
  pose[4] = y + h * (wy * w + wz * x - wx * z);
  pose[5] = z + h * (wz * w + wx * y - wy * x);
  pose[6] = w - h * (wx * x + wy * y + wz * z);
}

/**
 * The `count` slots listed in `list` moved on by `ahead` simulated seconds from their targets
 * (`target`, 7 numbers a slot) at their velocities (`velocity`, 6 a slot), each turn normalised:
 * into the drawn poses `position` (3 a slot) and `quaternion` (4 a slot).
 */
export function extrapolateAll(
  list: Int32Array,
  count: number,
  target: Float32Array,
  velocity: Float32Array,
  ahead: number,
  position: Float64Array,
  quaternion: Float64Array,
) {
  for (let i = 0; i < count; i++) {
    const index = list[i],
      p = index * 3,
      q = index * 4;
    extrapolate(pose, target, index * 7, velocity, index * 6, ahead);
    const x = pose[3],
      y = pose[4],
      z = pose[5],
      w = pose[6];
    const n = 1 / (Math.sqrt(x * x + y * y + z * z + w * w) || 1);
    for (let k = 0; k < 3; k++) position[p + k] = pose[k];
    quaternion[q] = x * n;
    quaternion[q + 1] = y * n;
    quaternion[q + 2] = z * n;
    quaternion[q + 3] = w * n;
  }
}
const pose = new Float64Array(7);
