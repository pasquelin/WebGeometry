import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { answering, type Answer } from '../cluster/answers.fixture.ts';
import { cooked, landed, modelFiles, modelStreamer, place, tile } from './tiles.fixture.ts';

/** A cooked file of one two-triangle tile, `t0.bin`, placed once. */
const FILE = cooked([{ kind: 'mesh', tiles: [tile()] }], [place(0)]);

/** A model whose `physics.json` is `file` and whose `name` answers `answers`, every other file as
 *  it is: its streamer, scanned once, and the requests of `name`. */
function streaming(t: TestContext, name: string, answers: Answer[], file: object = FILE) {
  const served = modelFiles(file, new Uint8Array(1));
  const asked = answering(t, name, answers, served, served);
  const streamer = modelStreamer();
  const opened = streamer.heard();
  streamer.tiles.scan(streamer.scene);
  return { ...streamer, asked, opened };
}

test('a model compiled before the cook — a 404, or the 403 of a store that hides it — collides nowhere', async (t) => {
  for (const status of [404, 403]) {
    t.mock.restoreAll();
    const { tiles, bodies, errors } = streaming(t, 'physics.json', [status]);
    await landed();
    tiles.update([0, 0, 0], 1000);
    await landed();
    assert.deepEqual([bodies.count.collisionBytes, errors], [0, []]);
  }
});

test('a tile a busy server refuses (503) is asked once per update: the next one brings it in', async (t) => {
  const { tiles, bodies, asked, opened, heard, errors } = streaming(t, 't0.bin', [503, 200]);
  await opened;
  const refused = heard();
  tiles.update([0, 0, 0], 1000);
  await refused;
  assert.deepEqual([asked.length, errors.length], [1, 1]);
  const resident = heard();
  tiles.update([0, 0, 0], 1000);
  await resident;
  assert.deepEqual([asked.length, bodies.count.collisionBytes], [2, 2]);
});

test('a tile the server refuses (404) is asked once, never at the next updates', async (t) => {
  const { tiles, asked, opened, heard, errors } = streaming(t, 't0.bin', [404]);
  await opened;
  const refused = heard();
  tiles.update([0, 0, 0], 1000);
  await refused;
  tiles.update([0, 0, 0], 1000);
  await landed();
  assert.deepEqual([asked.length, errors.length], [1, 1]);
});

test('a cooked file that lists no soft bodies still brings its tiles in, no failure', async (t) => {
  const { softBodies: _none, ...file } = FILE;
  const { tiles, bodies, opened, heard, errors } = streaming(t, 't0.bin', [200], file);
  await opened;
  const resident = heard();
  tiles.update([0, 0, 0], 1000);
  await resident;
  assert.deepEqual([bodies.count.collisionBytes, errors], [2, []]);
});

test('a model leaving while its physics.json or a tile is on its way lets the read go, no failure', async (t) => {
  for (const name of ['physics.json', 't0.bin']) {
    t.mock.restoreAll();
    const { tiles, scene, model, asked, opened, errors } = streaming(t, name, ['hang']);
    // A tile is asked once its model's file has landed.
    if (name === 't0.bin') await opened.then(() => tiles.update([0, 0, 0], 1000));
    scene.remove(model);
    tiles.scan(scene);
    assert.ok(asked[0].init.signal!.aborted);
    await landed();
    assert.deepEqual([asked.length, errors], [1, []]);
  }
});
