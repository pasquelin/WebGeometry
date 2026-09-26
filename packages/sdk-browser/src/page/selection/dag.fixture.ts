import { createEngineCamera, readCameraWorld } from '../../camera/world.ts';
import * as G from '../../host/graph/graph.fixture.ts';
import type { ClusterManifest } from '../../../../sdk-core/src/index.ts';
import { collectClusterPages, selectVisiblePages } from './selection.ts';
import { createHeldResidency } from '../cut/held.ts';

export function dagFixture() {
  const positions: number[] = [];
  for (let t = 0; t < 4; t++) {
    const x = -2 + t;
    positions.push(x, -0.5, 0, x + 1, -0.5, 0, x + 0.5, 0.5, 0);
  }
  const geometry = new G.Geometry();
  geometry.setAttribute('position', G.floatAttribute(positions, 3));
  geometry.setIndex(G.indices([...Array(12).keys()]));
  const mesh = G.mesh(geometry, G.basicSurface({ side: G.DOUBLE_SIDE }));
  const source = new G.Group();
  source.add(mesh);
  const leftSphere = [-1, 0, 0, 1.2],
    rightSphere = [1, 0, 0, 1.2],
    rootSphere = [0, 0, 0, 2.3];
  const midError = 0.02,
    rootError = 0.2;
  const leaf = (id: number) => ({
    id,
    url: `leaf${id}`,
    sha256: `leaf${id}`,
    bytes: 12,
    count: 3,
    min: [-2 + id, -0.5, 0],
    max: [-1 + id, 0.5, 0],
    role: 'exact' as const,
    level: 0,
    lodError: 0,
    sphere: [-1.5 + id, 0, 0, 0.6],
    parentError: midError,
    parentSphere: id < 2 ? leftSphere : rightSphere,
    group: id < 2 ? 0 : 1,
    source: null,
  });
  const pages = [
    leaf(0),
    leaf(1),
    leaf(2),
    leaf(3),
    {
      id: 4,
      url: 'mid-left',
      sha256: 'mid-left',
      bytes: 12,
      count: 3,
      min: [-2, -0.5, 0],
      max: [0, 0.5, 0],
      role: 'coarse' as const,
      level: 1,
      lodError: midError,
      sphere: leftSphere,
      parentError: rootError,
      parentSphere: rootSphere,
      group: 2,
      source: 0,
    },
    {
      id: 5,
      url: 'mid-right',
      sha256: 'mid-right',
      bytes: 12,
      count: 3,
      min: [0, -0.5, 0],
      max: [2, 0.5, 0],
      role: 'coarse' as const,
      level: 1,
      lodError: midError,
      sphere: rightSphere,
      parentError: rootError,
      parentSphere: rootSphere,
      group: 2,
      source: 1,
    },
    {
      id: 6,
      url: 'root',
      sha256: 'root',
      bytes: 12,
      count: 3,
      min: [-2, -0.5, 0],
      max: [2, 0.5, 0],
      role: 'coarse' as const,
      level: 2,
      lodError: rootError,
      sphere: rootSphere,
      parentError: null,
      parentSphere: null,
      group: null,
      source: 2,
    },
  ];
  const structure = {
    version: 1,
    roots: [6],
    groups: [
      { level: 1, error: midError, sphere: leftSphere, children: [0, 1], outputs: [4] },
      { level: 1, error: midError, sphere: rightSphere, children: [2, 3], outputs: [5] },
      { level: 2, error: rootError, sphere: rootSphere, children: [4, 5], outputs: [6] },
    ],
  };
  const metadata = {
    errorModel: 'dag-group-qem-v2',
    clusterStrategy: 'dag-groups',
    primitives: [
      {
        mesh: 0,
        primitive: 0,
        pass: 'exact-clusters',
        clusterStrategy: 'dag-groups' as const,
        pages,
        hierarchy: null,
        structure,
      },
    ],
  } as unknown as ClusterManifest;
  const indices = new Map(pages.map((page) => [page.url, new Uint32Array([0, 1, 2])]));
  for (let id = 0; id < 4; id++)
    indices.set(`leaf${id}`, new Uint32Array([id * 3, id * 3 + 1, id * 3 + 2]));
  return {
    geometry,
    mesh,
    source,
    metadata,
    indices,
    associations: new Map([[mesh, { meshes: 0, primitives: 0 }]]),
  };
}

/** A view of the origin down -z from (0, 0, `z`). */
export function frontCamera(z: number, far = 1000) {
  const cam = G.perspectiveCamera(55, 16 / 9, 0.1, far);
  cam.position.set(0, 0, z);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam;
}

export const wideCamera = () => frontCamera(5);

/** An oblique view of the origin from (3, 2, 9), as the zero-threshold cut tests decide under. */
export function obliqueCamera() {
  const cam = G.perspectiveCamera(55, 16 / 9, 0.25, 500);
  cam.position.set(3, 2, 9);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam;
}

const fixtureCam = createEngineCamera();

export function urls(
  fixture: ReturnType<typeof dagFixture>,
  pixelError: number,
  cam = wideCamera(),
) {
  const { roots } = collectClusterPages(
    fixture.source,
    fixture.metadata,
    fixture.indices,
    fixture.associations,
  );
  return selectVisiblePages(roots, readCameraWorld(fixtureCam, cam), {
    pixelError,
    viewport: [1280, 720],
    held: createHeldResidency(),
  })
    .shown.map((page) => page.url)
    .sort();
}
