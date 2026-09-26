// First part of the foundation bench, `sdk-browser` consumers: each computation attached to
// the foundation, opposed to the code it was before, copied in `oracles/socle-math*.ts`.
// A single different value and the line fails: the attachment changes no bit.
import * as THREE from 'three';
import { srgbToLinear } from '../../../../packages/sdk-core/src/index.ts';
import { orderPendingUrls } from '../../../../packages/sdk-browser/src/streaming/priority.ts';
import { linearToSrgb8 } from '../../../../packages/sdk-browser/src/visibility/math.ts';
import { projectVisibilityVertex } from '../../../../packages/sdk-browser/src/visibility/projection.ts';
import {
  setWindingEpoch,
  windingCw,
} from '../../../../packages/sdk-browser/src/webgpu/pages/render/winding.ts';
import { noteResidenceChange } from '../../../../packages/sdk-browser/src/webgpu/shadow/bounds.ts';
import { createWebgpuLightState } from '../../../../packages/sdk-browser/src/webgpu/pages/state/lights.ts';
import { shadowPoolSide } from '../../../../packages/sdk-core/src/scene/light-shadow/virtual.ts';
import { pageRecFixture } from './pageRecFixture.ts';
import * as ancien from '../../../oracles/browser/core-math.ts';
import { referenceOrder } from '../../../oracles/browser/core-math-priority.ts';
import { affines, matrices, points } from './scenesCore.ts';
import { enregistrements, octets } from './scenesCoreConsumers.ts';
import { essaie, ligne } from './coreLine.ts';
import {
  createEngineCamera,
  readCameraWorld,
} from '../../../../packages/sdk-browser/src/camera/world.ts';
import type { PageRec } from '../../../../packages/sdk-browser/src/page/selection/types.ts';

// One light, so `store.count` holds and `noteResidenceChange` actually notes a change; its
// scheduler's `representationChanged` is replaced per case below to capture the bounds it is
// called with, instead of applying them.
const lumieres = createWebgpuLightState(shadowPoolSide(1280, 720));
lumieres.store.add({
  id: 'l0',
  kind: 'point',
  position: [0, 0, 0],
  color: [1, 1, 1],
  intensity: 100,
  range: 20,
  castsShadow: true,
});

export async function lignesConsommateursBrowser() {
  const { liste, camera, echelle } = enregistrements;
  // The engine order reads the camera it owns; the oracle keeps that of the host library.
  const vue = readCameraWorld(createEngineCamera(), camera);
  const paquets: PageRec[][] = [];
  for (let i = 0; i < liste.length; i += 30) paquets.push(liste.slice(i, i + 30));
  // The page records are built once, outside the timed closure below: the compared subject is
  // `windingCw` alone — before the conversion the line also paid one object literal per matrix.
  const pagesHostiles = matrices.map((e) =>
    pageRecFixture({ matrix: new THREE.Matrix4().fromArray(e) }),
  );
  const attribut = new THREE.BufferAttribute(Float32Array.from(points.flat()), 3);
  // The compared subject is the projection of a vertex, not the read of a convention: the
  // view-projection/convention pairs are built once, outside the measured loops.
  const vuesProjetees = matrices.map((e) => ({ viewProjection: e }));
  return [
    await ligne(
      'streaming queue: rendered order',
      'packages/sdk-browser/src/streaming/priority.ts',
      'hostile records, in batches of 30',
      paquets,
      (l) => l.map((p) => essaie(() => referenceOrder(p, camera, echelle))),
      (l) => l.map((p) => essaie(() => orderPendingUrls(p, vue, echelle, []))),
    ),
    await ligne(
      'world-space cluster sphere for shadows',
      'packages/sdk-browser/src/webgpu/shadow/bounds.ts',
      'poses × boxes',
      liste,
      (l) =>
        l.map((r) => {
          const s = new Float32Array(4);
          ancien.referenceClusterSphere(r, s, 0);
          return [s[0] - s[3], s[1] - s[3], s[2] - s[3], s[0] + s[3], s[1] + s[3], s[2] + s[3]];
        }),
      (l) =>
        l.map((r) => {
          let boite: number[] | undefined;
          lumieres.plan.representationChanged = (min, max) => {
            boite = [...Array.from(min), ...Array.from(max)];
          };
          noteResidenceChange(lumieres, r);
          return boite ?? [];
        }),
    ),
    await ligne(
      'winding order of a cluster',
      'packages/sdk-browser/src/webgpu/pages/render/winding.ts',
      'hostile matrices',
      matrices,
      (l) => l.map((e) => ancien.referenceWindingCw(e)),
      (l) =>
        l.map((e, i) => {
          setWindingEpoch(i + 1);
          return windingCw(pagesHostiles[i]);
        }),
    ),
    await ligne(
      'projected vertex of the visibility buffer',
      'packages/sdk-browser/src/visibility/projection.ts',
      'poses × view-projections × vertices',
      affines.slice(0, 60),
      (l) =>
        l.flatMap((m, i) =>
          points
            .slice(0, 40)
            .map((_, v) =>
              ancien.referenceProjectVisibilityVertex(
                new THREE.Matrix4().fromArray(m),
                attribut,
                v,
                new THREE.Matrix4().fromArray(matrices[(i * 11) % matrices.length]),
                1280,
                720,
              ),
            ),
        ),
      (l) =>
        l.flatMap((m, i) =>
          points
            .slice(0, 40)
            .map((_, v) =>
              projectVisibilityVertex(
                new THREE.Matrix4().fromArray(m),
                attribut,
                v,
                vuesProjetees[(i * 11) % vuesProjetees.length],
                1280,
                720,
              ),
            ),
        ),
    ),
    await ligne(
      'sRGB: byte table and 8-bit encoding',
      'packages/sdk-browser/src/visibility/math.ts',
      '256 bytes and hostile values',
      octets,
      (l) =>
        l.map((c, i) => [ancien.referenceSrgb8Linear(i % 256), ancien.referenceLinearToSrgb8(c)]),
      (l) => l.map((c, i) => [srgbToLinear((i % 256) / 255), linearToSrgb8(c)]),
    ),
  ];
}
