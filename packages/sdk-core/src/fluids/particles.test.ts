import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTICLE_FLOATS, ParticlePool } from './particles.ts';

const emitMany = (pool: ParticlePool, n: number) => {
  for (let i = 0; i < n; i++) pool.emit(i, 0, 0, 0, 1, 0, 2);
};

test('a record is the particle as the GPU keeps it: position, age zero, velocity, lifetime', () => {
  const pool = new ParticlePool({ capacity: 8, emitPerFrame: 4 });
  assert.equal(pool.emit(1, 2, 3, 4, 5, 6, 7), true);
  assert.deepEqual([...pool.staging.subarray(0, PARTICLE_FLOATS)], [1, 2, 3, 0, 4, 5, 6, 7]);
  pool.advance(0.01);
  assert.deepEqual({ ...pool.flush() }, { first: 0, count: 1, dt: 0.01 });
});

test('the ring wraps past capacity onto the oldest slots, and allocates nothing after creation', () => {
  const pool = new ParticlePool({ capacity: 8, emitPerFrame: 4 });
  const staging = pool.staging,
    step = pool.flush(),
    slots = [];
  for (const n of [4, 4, 3, 2]) {
    emitMany(pool, n);
    assert.equal(pool.flush(), step, 'the same step object every image');
    slots.push(`${step.first}+${step.count}`);
  }
  // Slots 0..3, 4..7, then 0..2 overwrite the first image's particles, then 3..4.
  assert.deepEqual(slots, ['0+4', '4+4', '0+3', '3+2']);
  assert.equal(pool.staging, staging, 'the same staging');
  assert.equal(pool.emitted, 13);
});

test('a full staging refuses and counts; the step clamps its time and consumes it', () => {
  const pool = new ParticlePool({ capacity: 8, emitPerFrame: 2 });
  emitMany(pool, 3);
  assert.equal(pool.dropped, 1);
  pool.advance(1);
  assert.deepEqual({ ...pool.flush() }, { first: 0, count: 2, dt: 1 / 15 });
  assert.deepEqual({ ...pool.flush() }, { first: 2, count: 0, dt: 0 }, 'nothing twice');
});

test('a pool out of bounds is refused by name', () => {
  assert.throws(() => new ParticlePool({ capacity: 0 }), /^Error: PARTICLE_CAPACITY/);
  assert.equal(new ParticlePool({ capacity: 64 }).emitPerFrame, 64, 'the default, at most it');
  assert.throws(
    () => new ParticlePool({ capacity: 4, emitPerFrame: 5 }),
    /^Error: PARTICLE_EMISSION/,
  );
});

test('a particle ten kilometres out keeps its sub-millimetre steps: positions are from the origin', () => {
  const far = 10_000,
    pool = new ParticlePool({ capacity: 8, origin: [far, 0, far] });
  pool.emit(far + 0.5, 2, far, 0.024, 0, 0, 4);
  assert.deepEqual([...pool.staging.subarray(0, 3)], [0.5, 2, 0]);
  // A drift of 0.4 mm in one step of 1/60 s, in the GPU step's 32-bit arithmetic: x += vx × dt.
  const step = (x: number) => Math.fround(x + Math.fround(0.024 * Math.fround(1 / 60)));
  assert.ok(step(pool.staging[0]) > pool.staging[0], 'from the origin, the step is kept');
  assert.equal(step(Math.fround(far + 0.5)), Math.fround(far + 0.5), 'in world floats, lost');
});

test('an idle pool stops moving: its step takes no time once its last particle is dead', () => {
  const pool = new ParticlePool({ capacity: 8 });
  assert.equal(pool.moving, false, 'nothing emitted');
  pool.emit(0, 0, 0, 0, 0, 0, 0.1);
  assert.equal(pool.moving, true);
  for (const dt of [0.05, 0.05, 0.05, 0.05]) {
    pool.advance(dt);
    assert.equal(pool.flush().dt, dt);
  }
  assert.equal(pool.moving, false, 'the lifetime has run out');
  pool.advance(0.05);
  assert.equal(pool.flush().dt, 0);
});

test('a pool blends, sizes and softens as told, and refuses by name what no renderer draws', () => {
  const fire = new ParticlePool({ capacity: 8 });
  assert.deepEqual([fire.blend, fire.size, fire.softness], ['additive', 0.1, 0.1]);
  const smoke = new ParticlePool({ capacity: 8, blend: 'premultiplied', size: 2 });
  assert.deepEqual([smoke.blend, smoke.softness], ['premultiplied', 2], 'soft over its size');
  const blend = 'alpha' as ParticlePool['blend'];
  assert.throws(() => new ParticlePool({ capacity: 8, blend }), /^Error: PARTICLE_BLEND/);
  assert.throws(() => new ParticlePool({ capacity: 8, softness: 0 }), /^Error: PARTICLE_SIZE/);
  const color = [1, 1, 1] as unknown as [number, number, number, number];
  assert.throws(() => new ParticlePool({ capacity: 8, color }), /^Error: PARTICLE_COLOR/);
});
