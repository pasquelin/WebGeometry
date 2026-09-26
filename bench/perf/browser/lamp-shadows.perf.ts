// what lamp shadows cost on the CPU: world-space cluster spheres packed for the shadow
// pass, and the plan of pages to redraw when the scene moves.
import * as THREE from 'three';
import { createSceneLightStore } from '../../../packages/sdk-core/src/scene/light/store.ts';
import { createShadowPlan } from '../../../packages/sdk-core/src/scene/light-shadow/plan.ts';
import { shadowPoolSide } from '../../../packages/sdk-core/src/scene/light-shadow/virtual.ts';
import { packClusterSpheres } from '../../../packages/sdk-browser/src/webgpu/shadow/bounds.ts';
import { graine, mesure, rapport } from '../../core/index.ts';
import { referenceClusterSphere } from '../../oracles/browser/lamp-shadows.ts';
import { pageRecFixture } from './support/pageRecFixture.ts';
import type { PageRec } from '../../../packages/sdk-browser/src/page/selection/types.ts';
import type { ShadowViewpoint } from '../../../packages/sdk-core/src/index.ts';

const alea = graine(83);

// One record in ten is empty: the pass must write a zero radius there, never read a missing card.
// The output buffer belongs to the case, allocated once, as the engine holds its own.
function clusters(nombre: number) {
  const recs: (PageRec | undefined)[] = [];
  for (let i = 0; i < nombre; i++) {
    const elements = new Float64Array(16);
    for (let j = 0; j < 16; j++) elements[j] = (alea() - 0.5) * 10;
    const min = [(alea() - 0.5) * 5, (alea() - 0.5) * 5, (alea() - 0.5) * 5];
    const max = [min[0] + alea() * 5, min[1] + alea() * 5, min[2] + alea() * 5];
    recs.push(
      i % 10 === 9
        ? undefined
        : pageRecFixture({ matrix: new THREE.Matrix4().fromArray(elements), min, max }),
    );
  }
  return { recs, packed: new Float32Array(nombre * 4) };
}

const mesSpheres = await mesure({
  name: 'world-space cluster spheres',
  fichier: 'packages/sdk-browser/src/webgpu/shadow/bounds.ts',
  cas: [
    { name: '20 000 clusters', input: clusters(20000), size: 20000 },
    { name: '1 cluster', input: clusters(1), size: 1 },
    { name: 'none', input: clusters(0), size: 0 },
  ],
  calcul: ({ recs, packed }) => packClusterSpheres(recs, packed, 0, recs.length - 1),
  attendu: ({ recs }) => {
    const output = new Float32Array(recs.length * 4);
    recs.forEach((rec, i) => rec && referenceClusterSphere(rec, output, i * 4));
    return output;
  },
});

const vue: ShadowViewpoint = {
  position: [0, 0, 0],
  forward: [0, 0, -1],
  aspect: 1,
  near: 0.1,
  far: 1000,
  halfFovY: Math.PI / 4,
  pixelNear: (0.1 * 2) / 720,
};
const SCENE_MIN = [-30, 0, -30],
  SCENE_MAX = [30, 12, 30];

function scene(nombre: number) {
  const store = createSceneLightStore();
  for (let i = 0; i < nombre; i++)
    store.add({
      id: `light-${i}`,
      kind: 'point',
      position: [(alea() - 0.5) * 50, alea() * 10, (alea() - 0.5) * 50],
      color: [1, 1, 1],
      intensity: 100,
      range: 20,
      castsShadow: true,
    });
  return { store, plan: createShadowPlan(shadowPoolSide(1280, 720)), frame: 0 };
}

// Each frame, a node moves within lamp range: invalidation and admission work. A still
// scene would cost nothing, and that would be the published figure.
const mesOrdonnancement = await mesure({
  name: 'shadow-page plan',
  fichier: 'packages/sdk-core/src/scene/light-shadow/plan.ts',
  cas: [{ name: '32 lamps, moving scene', input: scene(32), size: 32 }],
  calcul: (s) => {
    s.frame++;
    const x = (s.frame % 40) - 20;
    s.plan.worldChanged([x, 0, x], [x + 2, 2, x + 2]);
    return s.plan.plan(s.store, vue, SCENE_MIN, SCENE_MAX, s.frame, s.frame * 16.6);
  },
  motif:
    'correctness held by packages/sdk-core/src/scene/light-shadow/plan.test.ts; the oracle would be a second scheduler',
});

rapport('lampes-ombres', [mesSpheres, mesOrdonnancement], 'the spheres yield the same values');
