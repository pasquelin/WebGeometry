import type { TablePartition } from '../../../../sdk-core/src/scene/core/tablePartition.ts';
import { Group, Object3D } from '../../../../sdk-core/src/world/object/object3d.ts';
import { createPartitionCells } from './cells.ts';
import { placedMesh, type RowLink } from './rows.ts';

/** Two cells of one mesh, one near the origin and one 5 km away; each hangs under a moved core
 *  node, or under the scene root when its `far` or `near` is null. */
export function world(far: number | null = 0, near: number | null = null) {
  const node = (x: number, parent: number | null) => ({
    parent,
    mesh: 7,
    matrix: null,
    translation: [x, 1, 2],
    rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    scale: [2, 2, 2],
  });
  const bodies: Record<string, unknown> = {
    'near.json': { version: 2, nodes: [node(1, near), node(3, near)] },
    'far.json': { version: 2, nodes: [node(5000, far)] },
  };
  const partition: TablePartition = {
    bounds: [0, 0, 0, 5010, 5, 5],
    meshes: [7],
    cells: [
      {
        url: 'near.json',
        sha256: '',
        bytes: 1,
        parents: [near === null ? [null, [0, 0, 0, 5, 5, 5]] : [0, [0, -10, 0, 5, -5, 5]]],
        meshes: [[7, 2]],
      },
      {
        url: 'far.json',
        sha256: '',
        bytes: 1,
        // Under the core node, 10 m up, or at the same place under the root.
        parents: [
          far === null ? [null, [5000, 0, 0, 5010, 5, 5]] : [0, [5000, -10, 0, 5010, -5, 5]],
        ],
        meshes: [[7, 1]],
      },
    ],
  };
  const root = new Group();
  const core = new Object3D();
  core.position.set(0, 10, 0);
  root.add(core);
  const links: RowLink[] = [
    { meshes: 7, primitives: 0 },
    { meshes: 7, primitives: 1 },
  ];
  const cells = createPartitionCells({
    partition,
    base: 'https://cache.test/key/',
    root,
    parents: [core],
    meshes: new Map([[7, placedMesh(links)]]),
  });
  const bytes = (url: string) =>
    new TextEncoder().encode(JSON.stringify(bodies[url.split('/').at(-1)!]));
  return { cells, links, root, core, bytes, node };
}
