import { TEMPLATES, sha, manifest } from '../../../../tests/fixtures/manifestBinary.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeManifestBinary, encodeManifestBinary, MANIFEST_BINARY_VERSION } from './binary.ts';
import { COLUMN_NAMES, MANIFEST_BINARY_HEADER_WORDS } from './binaryFormat.ts';
import type { EngineError } from '../contracts/index.ts';

function encoded() {
  const { manifest: slim, binary } = encodeManifestBinary(manifest(), TEMPLATES);
  slim.binary.sha256 = sha('f');
  const buffer = binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
  return { slim, buffer: buffer as ArrayBuffer };
}

test('every bundle keeps its closed dependency list and the published bound through the sidecar', () => {
  const { slim, buffer } = encoded();
  const streams = decodeManifestBinary(slim, buffer).primitives[0].streams!;
  assert.deepEqual(
    streams.pages.map((bundle) => bundle.dependencies),
    [[], [0]],
  );
  assert.equal(streams.dependencyBound, 1);
  assert.equal(streams.maxDependencies, 1);
});

test('a sidecar written before bundle dependencies, cooked cones or manifest pages is refused before it is read', () => {
  assert.equal(MANIFEST_BINARY_VERSION, 10);
  for (const version of [7, 8, 9]) {
    const { slim, buffer } = encoded();
    new Uint32Array(buffer, 4, 1)[0] = version;
    assert.throws(
      () => decodeManifestBinary(slim, buffer),
      (error: EngineError) => error.code === 'UNSUPPORTED_FORMAT',
    );
  }
});

test('a dependency column whose length contradicts the per-bundle counts is refused', () => {
  const { slim, buffer } = encoded();
  const column = COLUMN_NAMES.indexOf('bundleDependencyCount');
  const header = new Uint32Array(buffer, 0, MANIFEST_BINARY_HEADER_WORDS + COLUMN_NAMES.length * 2);
  const offset = header[MANIFEST_BINARY_HEADER_WORDS + column * 2];
  new Uint32Array(buffer, offset, 2)[1] = 2;
  assert.throws(
    () => decodeManifestBinary(slim, buffer),
    (error: EngineError) => error.code === 'INVALID_CACHE',
  );
});
