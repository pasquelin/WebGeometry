/**
 * The engine's particle pool (#420), stepped on the GPU (`sdk-browser/src/particles/`): a fixed
 * capacity, a ring where emission writes the oldest slot, the image's records staged in one buffer
 * made at creation. Nothing is compacted or read back: a particle past its lifetime is dead, and
 * the GPU skips it. Positions are from the pool's origin, its emitter's place: ten kilometres out a
 * particle still moves by a fraction of a millimetre, which 32-bit world floats round away. The
 * step never reads the origin; drawing adds it back (#755).
 */
import { GRAVITY_PRESETS } from '../physics/options.ts';

/** Floats of one particle and of one emission record, the same eight words: position from the
 *  origin then age, velocity then lifetime. A record's age is zero: the GPU copies it as it is. */
export const PARTICLE_FLOATS = 8;
/** The largest pool: 32 MiB of state on WebGPU, a 1024 × 2048 texture pair on WebGL2. */
const MAX_CAPACITY = 1 << 20;
/** The longest step an image takes, seconds: a stalled tab does not fling its particles away. */
const MAX_STEP = 1 / 15;

/** How particles blend: `additive` light in any order (fire), `premultiplied` cover (smoke). */
export const PARTICLE_BLENDS = ['additive', 'premultiplied'] as const;
export type ParticleBlend = (typeof PARTICLE_BLENDS)[number];

/** How a pool is made; the capacity is fixed for its life. */
export interface ParticlePoolSpec {
  /** Particles the pool holds; emission past it overwrites the oldest. */
  capacity: number;
  /** Records one image may stage: a sixty-fourth of the capacity by default, 256 to capacity. */
  emitPerFrame?: number;
  /** Metres per second squared on every live particle; gravity by default. */
  acceleration?: readonly [number, number, number];
  /** The emitter's place in the world, metres, fixed for the pool's life; the origin by default. */
  origin?: readonly [number, number, number];
  /** How the particles blend; `additive` by default. */
  blend?: ParticleBlend;
  /** Linear colour and opacity at birth, fading to nothing at death; a warm white by default. */
  color?: readonly [number, number, number, number];
  /** A particle's radius, metres; 0.1 by default. */
  size?: number;
  /** Metres over which a particle fades before the surface behind it; its `size` by default. */
  softness?: number;
}

/** One image's step: `count` records land from ring slot `first`, then live ones move `dt` s. */
export type ParticleStep = { first: number; count: number; dt: number };

export class ParticlePool {
  readonly capacity: number;
  readonly emitPerFrame: number;
  readonly acceleration: Float32Array;
  /** The origin in double precision: emission subtracts it before rounding to 32 bits. */
  readonly origin: Float64Array;
  readonly blend: ParticleBlend;
  readonly color: Float32Array;
  readonly size: number;
  readonly softness: number;
  /** The staged records, `emitPerFrame` of them, read by the renderer up to `step.count`. */
  readonly staging: Float32Array<ArrayBuffer>;
  /** Records staged since creation, and those refused: the image's staging full, or the pool
   *  `refused` by a renderer that cannot step it, which it then no longer asks frames for. */
  emitted = 0;
  dropped = 0;
  refused = false;
  private readonly step: ParticleStep = { first: 0, count: 0, dt: 0 };
  private cursor = 0;
  private staged = 0;
  private pending = 0;
  /** Seconds the longest-lived particle may have, one step over: the GPU's 32-bit age lags. */
  private liveFor = 0;

  constructor(spec: ParticlePoolSpec) {
    const { capacity, emitPerFrame, acceleration, origin, blend = 'additive' } = spec,
      { color = [1, 0.8, 0.5, 1], size = 0.1, softness = size } = spec;
    const perFrame = emitPerFrame ?? Math.min(capacity, Math.max(256, capacity >> 6));
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY)
      throw new Error(`PARTICLE_CAPACITY: a pool holds 1 to ${MAX_CAPACITY} particles`);
    if (!Number.isInteger(perFrame) || perFrame < 1 || perFrame > capacity)
      throw new Error('PARTICLE_EMISSION: a pool stages 1 to `capacity` records a frame');
    if (!PARTICLE_BLENDS.includes(blend))
      throw new Error(`PARTICLE_BLEND: a pool blends as ${PARTICLE_BLENDS.join(' or ')}`);
    if (!(size > 0) || !(softness > 0))
      throw new Error('PARTICLE_SIZE: a particle has a positive size and softness');
    if (color.length !== 4 || !color.every(Number.isFinite))
      throw new Error('PARTICLE_COLOR: a colour is four finite numbers, linear RGB and opacity');
    this.capacity = capacity;
    this.emitPerFrame = perFrame;
    this.acceleration = Float32Array.from(acceleration ?? [0, -GRAVITY_PRESETS.earth, 0]);
    this.origin = Float64Array.from(origin ?? [0, 0, 0]);
    this.staging = new Float32Array(perFrame * PARTICLE_FLOATS);
    this.blend = blend;
    this.color = Float32Array.from(color);
    this.size = size;
    this.softness = softness;
  }

  /** Stages one particle at world position `x, y, z`, born at the next image; false, and
   *  counted, when the image's staging is full. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, lifetime: number) {
    if (this.refused || this.staged === this.emitPerFrame) {
      this.dropped++;
      return false;
    }
    const at = this.staged++ * PARTICLE_FLOATS,
      words = this.staging,
      origin = this.origin;
    words[at] = x - origin[0];
    words[at + 1] = y - origin[1];
    words[at + 2] = z - origin[2];
    words[at + 3] = 0;
    words[at + 4] = vx;
    words[at + 5] = vy;
    words[at + 6] = vz;
    words[at + 7] = lifetime;
    this.liveFor = Math.max(this.liveFor, lifetime + MAX_STEP);
    this.emitted++;
    return true;
  }

  /** Whether the next step changes anything: a record staged, or a particle still alive. An idle
   *  pool neither dispatches nor keeps the image from being held. */
  get moving() {
    return !this.refused && (this.staged > 0 || this.liveFor > 0);
  }

  /** Adds `seconds` to the time the next image steps; an idle pool lets them pass untaken, so
   *  a held image's time never flings the next newborn particles. */
  advance(seconds: number) {
    if (this.moving) this.pending += seconds;
  }

  /** The step of the image being encoded, always the same object: the staged records take the
   *  ring's next slots, and the time advanced since the last step, clamped, is consumed; an idle
   *  pool's step takes no time. */
  flush(): Readonly<ParticleStep> {
    const step = this.step;
    step.first = this.cursor;
    step.count = this.staged;
    step.dt = Math.min(this.pending, MAX_STEP);
    this.liveFor -= step.dt;
    this.cursor = (this.cursor + this.staged) % this.capacity;
    this.staged = 0;
    this.pending = 0;
    return step;
  }
}
