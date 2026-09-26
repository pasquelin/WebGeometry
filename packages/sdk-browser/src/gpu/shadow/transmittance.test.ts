// #35: a blended caster's shadow is a half-resolution transmittance and a 32-bit translucent depth
// beside the pool, multiplied into the PCF.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLEND_TRANSMITTANCE_WGSL,
  SHADOW_TRANSLUCENT_DEPTH_FORMAT,
  TRANSMITTANCE_BLEND,
  TRANSMITTANCE_CLEAR,
  castsBlendShadow,
} from './transmittance.ts';
import { SHADOW_DEPTH_SHADER } from './shader.ts';
import { POISSON_16, directShadowWgsl } from '../../lighting/direct/shadowWgsl.ts';
import { LIGHT_SETTINGS } from '../../../../sdk-core/src/index.ts';
import { SHADOW_PAGE } from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { fromHalf, toHalf } from '../../../../sdk-core/src/lighting/ltcTable.ts';
import { surfaceOpacity, type PageSurface } from '../../page/surface.ts';

/** A texel of the layer: its transmittance and its translucent depth (reversed: nearer is more). */
type Texel = { t: number; d: number };
/** The nearest half float, portable where `Math.f16round` is missing. */
const f16 = (x: number) => fromHalf(toHalf(x));
const unorm8 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255) / 255;
const asked = { blending: 'normal', transmission: 0, transparentShadow: true };
const surface = (opacity: number) => ({ ...asked, opacity }) as unknown as PageSurface;
const CLEAR: Texel = { t: TRANSMITTANCE_CLEAR.r, d: 0 };

/** The GPU's colour blend on the layer's state, stored in 8 bits; its depth test keeps the
 *  nearest, stored in 32. */
function land(dst: Texel, coverage: number, depth: number): Texel {
  const { srcFactor, dstFactor } = TRANSMITTANCE_BLEND.color,
    src = 1 - coverage;
  const factor = (f: GPUBlendFactor | undefined) => (f === 'zero' ? 0 : f === 'src' ? src : 1);
  const t = unorm8(src * factor(srcFactor) + dst.t * factor(dstFactor));
  return { t, d: Math.max(dst.d, Math.fround(depth)) };
}

/** CPU oracle of `shadowThrough`: the four half-resolution texels around `a / 2`, kept in `a`'s
 *  page, each its transmittance where the reference lies behind its depth, filtered bilinearly. */
function through(layerAt: (i: number, j: number) => Texel, ax: number, ay: number, ref: number) {
  const half = SHADOW_PAGE / 2;
  const axis = (a: number) => {
    const o = Math.floor(a / SHADOW_PAGE) * half;
    const h = Math.min(Math.max(a / 2, o + 0.5), o + half - 0.5) - 0.5;
    return [Math.floor(h), h - Math.floor(h)];
  };
  const [i, fx] = axis(ax),
    [j, fy] = axis(ay);
  const s = (di: number, dj: number) => {
    const texel = layerAt(i + di, j + dj);
    return ref < texel.d ? texel.t : 1;
  };
  const mix = (a: number, b: number, f: number) => a + (b - a) * f;
  return mix(mix(s(0, 0), s(1, 0), fx), mix(s(0, 1), s(1, 1), fx), fy);
}

/** CPU oracle of `shadowPcf` away from a seam: the sixteen taps, each a bilinear depth comparison
 *  of the full-resolution pool, averaged, times `through` once at the footprint's centre. */
function pcf(depthAt: (x: number, y: number) => number, layerAt: (i: number, j: number) => Texel) {
  return (tx: number, ty: number, reference: number) => {
    let lit = 0;
    for (const [px, py] of POISSON_16) {
      const x = tx + px - 0.5,
        y = ty + py - 0.5,
        x0 = Math.floor(x),
        y0 = Math.floor(y),
        fx = x - x0,
        fy = y - y0;
      let compare = 0;
      for (const [dx, dy, w] of [
        [0, 0, (1 - fx) * (1 - fy)],
        [1, 0, fx * (1 - fy)],
        [0, 1, (1 - fx) * fy],
        [1, 1, fx * fy],
      ])
        compare += w * (reference > depthAt(x0 + dx, y0 + dy) ? 1 : 0);
      lit += compare;
    }
    return lit === 0 ? 0 : (lit / POISSON_16.length) * through(layerAt, tx, ty, reference);
  };
}
/** Spread of `read` over 32 × 32 receivers across a 4 × 4-texel window. */
function spread(read: (x: number, y: number) => number) {
  let low = Infinity,
    high = -Infinity;
  for (let i = 0; i < 32; i++)
    for (let j = 0; j < 32; j++) {
      const v = read(20 + i / 8, 20 + j / 8);
      low = Math.min(low, v);
      high = Math.max(high, v);
    }
  return { low, high };
}

test('the shadow read multiplies the PCF by the half-resolution layer once per footprint', () => {
  const wgsl = directShadowWgsl(8, null, 18);
  assert.match(wgsl, /@binding\(18\) var shadowTransmittance:texture_2d_array<f32>/);
  assert.match(wgsl, /@binding\(19\) var shadowTranslucentDepth:texture_depth_2d_array/);
  assert.match(wgsl, /clamp\(0\.5\*a,o\+0\.5,o\+\(0\.5\*SHADOW_PAGE-0\.5\)\)/, 'kept in its page');
  assert.match(wgsl, /let behind=vec4f\(reference\)<d;/);
  assert.equal(
    wgsl.match(/return shadowThroughLit\(offset\+vec3f\(t,0.0\),reference,lit\/f32\(PCF_TAPS\)\);/g)
      ?.length,
    2,
    'away from a seam and along one',
  );
  assert.equal(wgsl.match(/shadowThrough\(/g)?.length, 2, 'one read, never per tap');
  assert.match(
    wgsl,
    /if\(lit==0\.0\|\|textureDimensions\(shadowTransmittance\)\.x==1u\)\{return lit;\}/,
    'no layer: no texel read',
  );
  assert.ok(SHADOW_DEPTH_SHADER.includes(BLEND_TRANSMITTANCE_WGSL));
  assert.match(BLEND_TRANSMITTANCE_WGSL, /return vec4f\(1\.0-coverage\);/);
  assert.match(SHADOW_DEPTH_SHADER, /shadowHiddenByOpaque\(in\.position\)\)\{discard;\}/);
});

test('a filtered blended shadow is uniform over a constant opacity', () => {
  const opacity = 5 / 16;
  const layer = land(CLEAR, surfaceOpacity(surface(opacity)), 0.5);
  const read = pcf(
    () => 0,
    () => layer,
  );
  const { low, high } = spread((x, y) => read(x, y, 0.2));
  assert.equal(high - low, 0, 'no spatial variation');
  assert.ok(Math.abs(low - unorm8(1 - opacity)) < 1e-12, `${low}`);
  // The refused representation: the pane's depth kept on 5 texels of each 4×4 block, which the
  // same PCF averaged into a pattern swinging by a third of full shadow.
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const dithered = pcf(
    (x, y) => (opacity * 16 > bayer[(y & 3) * 4 + (x & 3)] ? 0.5 : 0),
    () => CLEAR,
  );
  const before = spread((x, y) => dithered(x, y, 0.2));
  assert.ok(before.high - before.low > 0.3, `${before.low} to ${before.high}`);
});

test('opacity 0 lets all the light through, opacity 1 none', () => {
  assert.equal(castsBlendShadow(surface(0)), false, 'no row: the texel keeps its clear value');
  assert.equal(CLEAR.t, 1);
  const opaque = land(CLEAR, surfaceOpacity(surface(1)), 0.5);
  assert.equal(opaque.t, 0);
  assert.equal(
    pcf(
      () => 0,
      () => opaque,
    )(10, 10, 0.2),
    0,
  );
});

test('two stacked panes multiply, whatever their order, and keep the nearest depth', () => {
  const a = land(land(CLEAR, 0.4, 0.7), 0.5, 0.3),
    b = land(land(CLEAR, 0.5, 0.3), 0.4, 0.7);
  assert.ok(Math.abs(a.t - b.t) <= 1 / 255, `${a.t} and ${b.t}`);
  assert.ok(Math.abs(a.t - 0.6 * 0.5) <= 1 / 255);
  assert.equal(a.d, Math.fround(0.7));
  assert.equal(b.d, Math.fround(0.7));
});

test('a receiver in front of the pane, or on it, keeps its light', () => {
  const pane = 0.62;
  const layer = land(CLEAR, 0.75, pane);
  const read = pcf(
    () => 0,
    () => layer,
  );
  assert.equal(read(10, 10, 0.9), 1, 'between the light and the pane');
  assert.equal(read(10, 10, Math.fround(pane)), 1, 'the pane itself, before any bias');
  assert.equal(read(10, 10, 0.3), unorm8(0.25), 'behind it');
});

test('a receiver 2 m behind a pane is attenuated anywhere in a 4 km sun range', () => {
  assert.equal(SHADOW_TRANSLUCENT_DEPTH_FORMAT, 'depth32float');
  // A receiver facing the sun, read at metre-wide texels: its margin is its normal offset.
  const range = 4000,
    bias = LIGHT_SETTINGS.shadowNormalOffsetTexels / range;
  let missed = 0,
    missedHalf = 0;
  for (let metres = 1; metres < range - 2; metres += 0.25) {
    const pane = 1 - metres / range,
      reference = 1 - (metres + 2) / range + bias;
    const layer = land(CLEAR, 0.5, pane);
    if (through(() => layer, 40, 40, reference) === 1) missed++;
    // The refused layer: the depth lowered by one half-float step and stored at half precision.
    if (!(reference <= f16(pane * (1 - 2 ** -11)))) missedHalf++;
  }
  assert.equal(missed, 0);
  assert.ok(missedHalf > 0, 'the half-float depth missed some');
});

test("a tap near a page's edge never reads the neighbouring page of the layer", () => {
  const half = SHADOW_PAGE / 2;
  const layerAt = (i: number) => (i >= half ? land(CLEAR, 1, 0.9) : CLEAR);
  assert.equal(through(layerAt, SHADOW_PAGE - 0.01, 10, 0.2), 1, 'last texel of page 0');
  assert.equal(through(layerAt, SHADOW_PAGE + 0.01, 10, 0.2), 0, 'first texel of page 1');
});
