// The normal cone the WebGPU prepare built from the host vertices until #272, kept as the reference
// the compiler's cooked cone and the run-time cut's are checked against
// (`packages/page-codec-wasm/src/normal_cone.rs`, `tests/integration/cooked-cones.test.ts`,
// `packages/sdk-browser/src/world/page/cutCones.test.ts`) and the input the cone tests and probes
// build from. No engine source calls it: the engine reads the cone `normal_cone.rs` built.
import { OPEN_CONE, type NormalCone } from '../../packages/sdk-browser/src/page/cone/cone.ts';

/** Ulps a built angle may stand above this reference's: twice `ANGLE_MARGIN_ULPS` (4,
 *  `normal_cone.rs`). */
const WIDEST = 2n * 4n;
/** The float64 words of `values`: bit for bit, and ulps apart for two numbers of one sign. */
const words = (values: number[]) =>
  Array.from(new BigUint64Array(Float64Array.from(values).buffer));

/** Whether `cone`, built by `normal_cone.rs`, holds `reference` (`triangleCone` on the same
 *  triangles): the same axis bit for bit, an angle no narrower and at most `WIDEST` ulps wider. */
export function coneHolds(cone: NormalCone, reference: NormalCone): boolean {
  const built = words([...cone.axis, cone.angle]),
    expected = words([...reference.axis, reference.angle]);
  const wider = built[3] - expected[3];
  return built.slice(0, 3).join() === expected.slice(0, 3).join() && wider >= 0n && wider <= WIDEST;
}

function faceCross(positions: ArrayLike<number>, ia: number, ib: number, ic: number) {
  const ax = positions[ia],
    ay = positions[ia + 1],
    az = positions[ia + 2];
  const e1x = positions[ib] - ax,
    e1y = positions[ib + 1] - ay,
    e1z = positions[ib + 2] - az;
  const e2x = positions[ic] - ax,
    e2y = positions[ic + 1] - ay,
    e2z = positions[ic + 2] - az;
  return [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x] as const;
}

/** Bounding cone of triangle normals. Degenerate faces skipped; none valid → OPEN_CONE. */
export function triangleCone(positions: ArrayLike<number>, indices: ArrayLike<number>): NormalCone {
  let sx = 0,
    sy = 0,
    sz = 0,
    count = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const c = faceCross(positions, indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3);
    const len = Math.hypot(c[0], c[1], c[2]);
    if (!(len > 0)) continue;
    sx += c[0];
    sy += c[1];
    sz += c[2];
    count++;
  }
  if (!count) return OPEN_CONE;
  const sl = Math.hypot(sx, sy, sz);
  if (!(sl > 0)) return OPEN_CONE;
  const axis: [number, number, number] = [sx / sl, sy / sl, sz / sl];
  let angle = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const c = faceCross(positions, indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3);
    const len = Math.hypot(c[0], c[1], c[2]);
    if (!(len > 0)) continue;
    const d = Math.min(1, Math.max(-1, (c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2]) / len));
    const a = Math.acos(d);
    if (a > angle) angle = a;
  }
  return { axis, angle };
}
