import type { GraphScene } from '../../host/graph/scene.ts';
import {
  DEFAULT_TONE_MAPPING,
  TONE_MAPPING_RANK,
} from '../../../../sdk-core/src/scene/core/environment.ts';
import { multiplyMatrix4Typed } from '../../../../sdk-core/src/math/matrix/matrix4Typed.ts';
import type { HostDrawOutput } from '../core/renderTarget.ts';
import type { HostCamera, HostDrawCamera } from '../../camera/world.ts';
import type { WholeMesh } from '../../cluster/batchMesh.ts';
import { firstMaterial } from '../../scene/materialSide.ts';
import type { WebglClusterScene } from './lights.ts';
import type { SceneCopy } from './copyCulling.ts';
import { WebglClusterOwner } from './owner.ts';
import { depthOf } from './meshDepth.ts';
import { meshes } from '../../scene/meshes.ts';
import { DEFAULT_PIXEL_RATIO } from '../../backend/common.ts';
import type { BackendHostDraw } from '../../backend/hostDraw.ts';
import type { BackendContext } from '../../backend/types.ts';
import { linearRefusalOf } from './linearRefusal.ts';

/** The scene the owner reads for its lights and background, its world matrices resolved
 *  before the read. */
export type ClusterDrawScene = WebglClusterScene & { updateMatrixWorld(): void };

/** A node of the display graph, read by shape: a mesh is drawn whole, anything else is walked. */
type DisplayNode = Partial<SceneCopy> & {
  readonly matrixWorld: SceneCopy['matrixWorld'];
  readonly kind?: string;
  readonly visible: boolean;
  readonly renderOrder: number;
  readonly children: readonly DisplayNode[];
};
/** A drawn node: the engine's mesh, numbered in creation order (a group or a bare node is not). */
type DrawnNode = DisplayNode & { readonly serial: number };
type DisplayScene = ClusterDrawScene & {
  readonly children: readonly DisplayNode[];
  onBeforeRender?(): void;
  onAfterRender?(): void;
};

/** What the session gives the draw: its pixel ratio and its degraded-surface notice. */
type DrawHosts = Pick<BackendContext, 'pixelRatio' | 'materialDegraded'>;

/** A scene draw hands the program no page batch: shared, so a frame allocates no empty list. */
const NO_BATCHES: readonly never[] = [];

/**
 * THE ENGINE'S DRAW OF A DISPLAY GRAPH: every visible mesh the graph holds, drawn whole by the
 * engine's program (`owner.ts`) in the order the reference draws a scene — the opaque meshes by
 * `renderOrder`, surface and depth, then the see-through ones and the transparent copies `copies` names, by
 * `renderOrder` and from the farthest to the nearest; the program splits them into its
 * transmission and blend passes. The lights and the background are read off the same graph.
 *
 * `render(camera)` opens the frame: it zeroes the counters, so that a frame
 * the composer held — nothing drawn — publishes nothing, never the previous draw; `counters()` is
 * `null` before the first frame. The graph is walked once per drawn image, at the first of
 * `host.linearRefusal` and `host.drawHostGeometry`: never on a held frame, and never in `render`,
 * which runs before the engine's frame writes the graph (`../../backend/autonomous/pages.ts`). Asked
 * first, it walks before `onBeforeRender`, whose one hook (`../../lighting/unlitAlbedo.ts`) writes
 * no field the walk reads. Without a context (a session that never draws on the host
 * surface) the draw is refused by name. `pixelRatio`, read each frame, scales a line's CSS-pixel
 * width to the image's pixels; `materialDegraded` hears a surface drawn without a physical feature.
 */
export function createSceneDraw(
  gl: WebGL2RenderingContext | undefined,
  display: GraphScene,
  copies: readonly object[] = [],
  { pixelRatio = () => DEFAULT_PIXEL_RATIO, materialDegraded }: DrawHosts = {},
) {
  const scene: DisplayScene = display;
  // The copies list grows with the placement rows (`growBlendCopies`): the set follows it.
  const copied = new Set<DisplayNode>();
  const followCopies = () => {
    for (let i = copied.size; i < copies.length; i++) copied.add(copies[i] as DisplayNode);
  };
  // Reused from frame to frame: a draw allocates no list.
  const opaque: WholeMesh[] = [],
    seeThrough: DrawnNode[] = [];
  let owner: WebglClusterOwner | undefined,
    opened = false,
    walked = false;
  // The projection times the view, and each drawn mesh's depth, read once a frame.
  const screen = new Float64Array(16),
    depths = new Map<DisplayNode, number>();
  const depth = (node: DisplayNode) => depths.get(node)!;
  const counters = { triangles: 0 };
  const collect = (node: DisplayNode) => {
    if (!node.visible) return;
    if (node.kind === 'mesh' || node.kind === 'instancedMesh') {
      if (copied.has(node) || firstMaterial(node.material!)?.transparent)
        seeThrough.push(node as DrawnNode);
      else opaque.push(node as WholeMesh);
    }
    for (const child of node.children) collect(child);
  };
  /** The image's one walk of the graph: its world matrices, then what it draws, sorted later. */
  const walk = () => {
    if (walked) return;
    walked = true;
    scene.updateMatrixWorld();
    opaque.length = seeThrough.length = 0;
    followCopies();
    for (const child of scene.children) collect(child);
  };
  // Opaque meshes of one order are grouped by surface, numbered as first met, as the reference
  // groups them by the surfaces it numbers as it meets them — a run of one surface binds it once
  // —, then drawn from the nearest; a tie is broken by the node's number, as the reference's is.
  const ranks = new WeakMap<object, number>();
  let nextRank = 0;
  const rankOf = (mesh: WholeMesh) => {
    const surface = mesh.material as object;
    let rank = ranks.get(surface);
    if (rank === undefined) ranks.set(surface, (rank = nextRank++));
    return rank;
  };
  const frontToBack = (a: DrawnNode, b: DrawnNode) =>
    a.renderOrder - b.renderOrder ||
    rankOf(a as WholeMesh) - rankOf(b as WholeMesh) ||
    depth(a) - depth(b) ||
    a.serial - b.serial;
  const backToFront = (a: DrawnNode, b: DrawnNode) =>
    a.renderOrder - b.renderOrder || depth(b) - depth(a) || a.serial - b.serial;
  const host: Required<BackendHostDraw> = {
    // Only a see-through mesh can refuse: the walk's list of them, still in graph order.
    linearRefusal() {
      walk();
      for (const node of seeThrough) {
        const mode = linearRefusalOf(node);
        if (mode) return mode;
      }
    },
    drawHostGeometry(drawCamera: HostDrawCamera, output: HostDrawOutput) {
      if (!gl) throw new Error('HOST_SURFACE_MISSING');
      if (!opened) throw new Error('Draw before render');
      owner ??= new WebglClusterOwner(gl, materialDegraded);
      if (!owner.censused) owner.census(meshes(display));
      owner.toneCurve = TONE_MAPPING_RANK[output.toneMapping ?? DEFAULT_TONE_MAPPING];
      owner.pixelRatio = pixelRatio();
      scene.onBeforeRender?.();
      try {
        walk();
        depths.clear();
        multiplyMatrix4Typed(screen, drawCamera.projection, drawCamera.view);
        for (const node of opaque as DrawnNode[]) depths.set(node, depthOf(node, screen));
        for (const node of seeThrough) depths.set(node, depthOf(node, screen));
        (opaque as DrawnNode[]).sort(frontToBack);
        seeThrough.sort(backToFront);
        // A linear output is the effect chain's: its own program, which leaves the curve and the
        // encoding to the chain and marks the surfaces the curve skips.
        owner.draw(
          NO_BATCHES,
          scene,
          drawCamera,
          output.toneMapped,
          !output.linear,
          opaque,
          seeThrough as readonly SceneCopy[],
          output.linear,
        );
      } finally {
        // A second draw of the same image — a capture — walks again, as every draw did.
        walked = false;
        scene.onAfterRender?.();
      }
      counters.triangles = owner.submittedTriangles;
    },
  };
  return {
    render(_camera: HostCamera) {
      counters.triangles = 0;
      opened = true;
      walked = false;
    },
    host,
    counters: () => (opened ? counters : null),
    dispose() {
      owner?.dispose();
      owner = undefined;
    },
  };
}
