import { invertMatrix4, matrixAtRenderOrigin } from '../../../sdk-core/src/math/index.ts';
import type { ParticlePool } from '../../../sdk-core/src/fluids/particles.ts';
import { usedSlots } from './poolStates.ts';

/** The words the particle draw (#755) gives a pool: clip matrix from its origin and inverse, made
 *  in double precision, eye from the origin, radius, colour at birth, softness; words 41–43 pad
 *  to the WGSL struct's size. */
export const DRAW_FLOATS = 44;

/** A disc's two triangles, corner by corner, in both shading languages (`vec2` infers in WGSL). */
export const DISC_CORNERS =
  'vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)';

type Vec = ArrayLike<number>;
const [clip, unclip] = [new Float64Array(16), new Float64Array(16)];

/** Writes `pool`'s draw words into `out` from the image's world `viewProj` and `eye`. */
export function writeDrawWords(out: Float32Array, pool: ParticlePool, viewProj: Vec, eye: Vec) {
  const o = pool.origin;
  matrixAtRenderOrigin(clip, viewProj, o);
  invertMatrix4(unclip, clip);
  out.set(clip, 0);
  out.set(unclip, 16);
  for (let i = 0; i < 3; i++) out[32 + i] = eye[i] - o[i];
  out[35] = pool.size;
  out.set(pool.color, 36);
  out[40] = pool.softness;
}

const keys: number[] = [];

/** The pools with particles alive, in `into`, far to near from `eye` by origin: one emitter's
 *  smoke over the one behind it, nothing sorted within a pool, nothing allocated. */
export function drawOrder(pools: readonly ParticlePool[], eye: Vec, into: ParticlePool[]) {
  into.length = 0;
  for (const pool of pools) {
    if (!pool.moving || !usedSlots(pool)) continue;
    const o = pool.origin,
      key = (o[0] - eye[0]) ** 2 + (o[1] - eye[1]) ** 2 + (o[2] - eye[2]) ** 2;
    let at = into.length;
    for (; at > 0 && keys[at - 1] < key; at--) {
      into[at] = into[at - 1];
      keys[at] = keys[at - 1];
    }
    into[at] = pool;
    keys[at] = key;
  }
  return into;
}
