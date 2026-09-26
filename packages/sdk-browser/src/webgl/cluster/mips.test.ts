// #42: WebGL2 mips reduced as WebGPU's, weighted by alpha under the readers' rule. #709 sampled the
// texture it drew into: refused, every level stayed a null allocation (alpha 0), every leaf cut.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebglClusterTextures } from './textures.ts';
import { importHostTexture } from '../../host/textureImport.ts';
import type { HostTexture } from '../../host/resources.ts';
import * as G from '../../host/graph/graph.fixture.ts';
import { createSceneDraw } from './sceneDraw.ts';
import { createTestContext } from '../core/testContext.fixture.ts';
import { createHostDrawCamera, type HostCamera } from '../../camera/world.ts';
import { CoverageReaders } from '../../texture/coverage.ts';
import { hostSurface } from '../../world/core/worldSurface.ts';
import { texture } from '../../world/texture/index.ts';
import { material } from '../../../../sdk-core/src/world/material/index.ts';

const output = { toneMapped: false, framebuffer: null, width: 8, height: 4 };

/** A test context; `draws`: per draw, the texture sampled, and the texture and level drawn. */
function context(answers: Record<string, unknown> = {}) {
  const view = (name: string) =>
    name === 'COLOR_WRITEMASK'
      ? [true, true, true, true]
      : name === 'MAX_TEXTURE_SIZE'
        ? 16384
        : new Int32Array([0, 0, 8, 4]);
  const gl = createTestContext({ answers: { getParameter: view, ...answers } });
  const uniforms = (name: string) =>
    gl.of('uniform1i').flatMap(([at, value]) => ((at as Named).uniform === name ? [value] : []));
  const draws = () => {
    const units = new Map<unknown, unknown>(),
      found: unknown[][] = [];
    let active,
      into: unknown[] = [];
    for (const { name, args } of gl.calls)
      if (name === 'activeTexture') active = args[0];
      else if (name === 'bindTexture') units.set(active, args[1]);
      else if (name === 'framebufferTexture2D' && args[0] === 'DRAW_FRAMEBUFFER') into = args;
      else if (name === 'drawArrays')
        found.push([units.get(`TEXTURE0${uniforms('source').at(-1)}`), into[3], into[4]]);
    return found;
  };
  const box = (name: string) =>
    name === 'generateMipmap' ? 'box ' : name === 'drawArrays' ? 'draw ' : '';
  return { ...gl, draws, chains: () => gl.names().map(box).join('').trim() };
}
type Named = { uniform: string };
/** A 4×4 map with mips, a masked surface wearing it, and a binder whose frame has begun. */
function masked(gl: WebGL2RenderingContext) {
  const host = G.dataTexture(new Uint8Array(64), 4, 4);
  host.minFilter = G.HOST_FILTER_LINEAR_MIP_LINEAR;
  const binder = new WebglClusterTextures(gl),
    surface = G.standardSurface({ map: host, alphaTest: 0.5 });
  binder.file(surface);
  binder.beginFrame();
  return { host, map: importHostTexture(host as unknown as HostTexture), binder, surface };
}

test('each level is drawn from a copy of the level above, never from the texture it fills', () => {
  const gl = context();
  const { map, binder } = masked(gl.gl);
  binder.bind(0, map, true, undefined, true);
  (map as { version: number }).version++; // a live picture: refilled in place, drawn over again
  binder.bind(0, map, true, undefined, true);
  const draws = gl.draws();
  const levels = draws.map((draw) => draw[2]);
  assert.deepEqual(levels, [1, 2, 1, 2]);
  assert.ok(draws.every(([sampled, target]) => sampled && sampled !== target));
  assert.deepEqual([gl.of('copyTexSubImage2D').length, gl.of('generateMipmap').length], [4, 1]);
  assert.ok(gl.names().indexOf('generateMipmap') < gl.names().indexOf('drawArrays'), 'box first');
  assert.deepEqual(gl.of('texImage2D').filter((args) => args[1] !== 0).length, 0);
});

test('a format no framebuffer holds keeps the box chain, never levels left empty', () => {
  let asked = 0;
  const gl = context({ checkFramebufferStatus: () => (asked++, 'FRAMEBUFFER_UNSUPPORTED') });
  const { map, binder } = masked(gl.gl);
  binder.bind(0, map, true, undefined, true);
  binder.bind(1, masked(gl.gl).map, true, undefined, true);
  assert.deepEqual([gl.draws().length, gl.of('generateMipmap').length, asked], [0, 2, 1]);
});

test('a chain follows the coverage rule of its readers, switched after its image', () => {
  const gl = context();
  const { host, map, binder, surface } = masked(gl.gl);
  const image = () => (binder.beginFrame(), binder.bind(0, map, true, undefined, true));
  for (const alphaTest of [0.5, 0.5, 0, 0.5]) {
    surface.alphaTest = alphaTest;
    image();
  }
  assert.equal(gl.of('texImage2D').filter((args) => args.at(-1) !== null).length, 1, 'uploads');
  // While it weighs: a linear-tagged map by its role, a data binding of the same texture plain.
  binder.bind(1, map, false, undefined, true);
  binder.bind(2, map, true, undefined, false);
  binder.file(G.standardSurface({ map: host }));
  image();
  // Masked, opaque (the box alone), masked over its chain, linear-tagged, data, an opaque reader.
  assert.equal(gl.chains(), 'box draw draw box draw draw box draw draw box box');
  [1, 2].forEach(() => binder.beginFrame());
  const held = gl.of('createTexture').length - gl.of('deleteTexture').length;
  assert.equal(held, 3, 'three chains, the scratches returned after an image with no reduction');
});

// Filed once — the census at the first draw, hidden meshes too —, reread per drawn map and image.
test('a still scene files each surface once across frames, a hidden opaque one included', (t) => {
  const read = t.mock.method(CoverageReaders.prototype, 'read');
  const follow = t.mock.method(CoverageReaders.prototype, 'follow');
  const map = new G.GraphTexture({ width: 4, height: 4 } as TexImageSource);
  const geometry = G.boxGeometry();
  const hidden = G.mesh(geometry, G.standardSurface({ map }));
  hidden.visible = false;
  const scene = new G.GraphScene();
  scene.add(G.mesh(geometry, G.standardSurface({ map, alphaTest: 0.5 })), hidden);
  const gl = context();
  const draw = createSceneDraw(gl.gl, scene);
  for (let frame = 0; frame < 3; frame++) {
    draw.render({} as HostCamera);
    draw.host.drawHostGeometry(createHostDrawCamera(), output);
  }
  const filed = read.mock.calls.filter((call) => call.result).length;
  assert.deepEqual([filed, follow.mock.callCount()], [2, 3]);
  assert.equal(gl.chains(), 'box', 'plain, the box chain: the hidden reader is opaque');
  draw.dispose();
});

// #443: a world texel map — `texture.data`, a file the loader decoded — is drawn on WebGL2 as on
// WebGPU: uploaded as the bytes it holds, with the chain its filter reads (none: incomplete, black).
test('a world texel map is uploaded as stored, with its box chain', () => {
  const pixels = new Uint8Array(4 * 4 * 4).fill(128);
  const scene = new G.GraphScene();
  const surface = material.meshStandard({ normalMap: texture.data(pixels, 4, 4) });
  scene.add(G.mesh(G.boxGeometry(), hostSurface(surface, false, new Map())));
  const gl = context();
  const draw = createSceneDraw(gl.gl, scene);
  draw.render({} as HostCamera);
  draw.host.drawHostGeometry(createHostDrawCamera(), output);
  draw.dispose();
  const uploaded = gl.of('texImage2D').map((args) => (args[8] as ArrayBufferView | null)?.buffer);
  assert.ok(uploaded.includes(pixels.buffer), 'uploaded as the bytes it holds');
  assert.equal(gl.chains(), 'box', 'a normal map is data: the plain box chain (#42)');
});

// #769: where float targets blend, a masked chain counts each level — level 0 first — as points,
// four a texel (#43), picks its `t` into the scratch's row under the level it holds, then reduces
// it, and gives the blend function back; a new cutoff reduces it again. Elsewhere it keeps the median alone.
test('a masked chain is counted at its cutoff where float targets blend, else keeps the median', () => {
  for (const extension of [{}, null]) {
    const gl = context({ getExtension: () => extension });
    const { map, binder, surface } = masked(gl.gl);
    binder.bind(0, map, true, undefined, true);
    surface.alphaTest = 0.25;
    binder.beginFrame();
    binder.bind(0, map, true, undefined, true);
    const cutoffs = gl
      .of('uniform1ui')
      .flatMap(([at, value]) => ((at as Named).uniform === 'cutoff' ? [value] : []));
    const draws = gl.of('drawArrays').map(([mode]) => mode);
    const points = gl.of('drawArrays').flatMap(([mode, , n]) => (mode === 'POINTS' ? [n] : []));
    if (!extension) {
      assert.deepEqual([cutoffs, draws], [[0, 0], Array(4).fill('TRIANGLES')], 'the median alone');
      continue;
    }
    const level = ['POINTS', 'TRIANGLES', 'TRIANGLES'];
    assert.deepEqual(draws, [...['POINTS', ...level, ...level], ...['POINTS', ...level, ...level]]);
    const each = (cutoff: number) => Array<number>(5).fill(cutoff); // reduction, counts, picks
    assert.deepEqual(cutoffs, [...each(128), ...each(64)]);
    assert.deepEqual(points, [64, 16, 4, 64, 16, 4], 'four samples a texel, levels 0 to 2 of 4²');
    // Each pick on the row under the level the scratch holds (4, then 2), then level 2's 1 × 1.
    const picks = [
      [0, 4, 1, 1],
      [0, 2, 1, 1],
      [0, 0, 1, 1],
    ];
    assert.deepEqual(
      gl.of('viewport').filter((box) => box[2] === 1),
      [...picks, ...picks],
    );
    assert.equal(gl.of('blendFuncSeparate').length, 2, 'blend function given back, once a chain');
  }
});

// A picture as tall as the context allows has no row under it for `t`: its chain keeps the median,
// its scratch no taller than the picture — a row more would be refused, every level left empty.
test('a chain as tall as the context allows keeps the median, its scratch no row more', () => {
  const view = (name: string) =>
    name === 'COLOR_WRITEMASK'
      ? [true, true, true, true]
      : name === 'MAX_TEXTURE_SIZE'
        ? 4
        : new Int32Array([0, 0, 8, 4]);
  const gl = context({ getParameter: view });
  const { map, binder } = masked(gl.gl);
  binder.bind(0, map, true, undefined, true);
  assert.deepEqual(gl.of('uniform1ui'), [[{ uniform: 'cutoff' }, 0]]);
  assert.equal(gl.of('drawArrays').length, 2, 'two levels reduced, none counted');
  assert.deepEqual(
    gl.of('texImage2D').flatMap((args) => (args.at(-1) === null ? [args[4]] : [])),
    [4],
  );
});
