import type { ClusterDrawMesh, WholeMesh } from '../../cluster/batchMesh.ts';
import { TONE_MAPPING_RANK } from '../../../../sdk-core/src/index.ts';
import { WebglClusterRenderer } from './renderer.ts';
import type { WebglClusterScene } from './lights.ts';
import type { SceneCopy } from './copyCulling.ts';
import type { HostDrawCamera } from '../../camera/world.ts';
import type { HostMaterials } from '../../host/resources.ts';
import { readDegraded, type MaterialDegraded, type ReadDegraded } from './validation.ts';

/**
 * The one draw owner of a session's paged clusters, diagnostic pages and scene copies. A draw
 * into the effect chain's linear target (`linear`) goes through a second program, made at the
 * first such draw, which shares the first's vertex arrays, maps and backdrop: a session that never
 * draws a chain compiles and binds exactly what it did without one.
 */
export class WebglClusterOwner {
  private display: WebglClusterRenderer;
  private linear: WebglClusterRenderer | undefined;
  /** The renderer of the last draw, whose counters the getters report. */
  private renderer: WebglClusterRenderer;
  private context: WebGL2RenderingContext;
  private restored = () => {
    this.release();
    this.renderer = this.display = new WebglClusterRenderer(this.context);
    this.censused = false;
  };
  censused = false;
  /** Files every mesh, hidden ones too — WebGPU's census at prepare (#42) —; a later one at bind. */
  census(meshes: readonly { material: HostMaterials }[]) {
    for (const { material } of meshes) this.display.textures.file(material);
    this.censused = true;
  }
  /** Reads the surfaces drawn without a physical feature for `hear`, across context restores. */
  private degraded: ReadDegraded | undefined;
  constructor(context: WebGL2RenderingContext, hear?: MaterialDegraded) {
    this.context = context;
    this.degraded = hear && readDegraded(hear);
    this.renderer = this.display = new WebglClusterRenderer(context);
    context.canvas.addEventListener('webglcontextrestored', this.restored);
  }
  /** The display curve of the frames to come, a rank of `TONE_MAPPING_RANK`. */
  toneCurve: number = TONE_MAPPING_RANK.aces;
  /** Image pixels per CSS pixel of the frames to come: the scale of a line's width. */
  pixelRatio = 1;
  get backdropBytes() {
    return this.renderer.backdropBytes;
  }
  get copySubmissions() {
    return this.renderer.copySubmissions;
  }
  get backdropPasses() {
    return this.renderer.backdropPasses;
  }
  /** Triangles the last frame submitted, every pass included. */
  get submittedTriangles() {
    return this.renderer.triangles;
  }
  get backdropSubmissions() {
    return this.renderer.backdropSubmissions;
  }
  draw(
    meshes: readonly ClusterDrawMesh[],
    scene: WebglClusterScene,
    camera: HostDrawCamera,
    toneMapped: boolean,
    srgbDestination: boolean,
    diagnosticMeshes: readonly WholeMesh[] = [],
    copies: readonly SceneCopy[] = [],
    linear = false,
  ) {
    if (linear) this.linear ??= new WebglClusterRenderer(this.context, this.display);
    const renderer = (this.renderer = linear ? this.linear! : this.display);
    renderer.toneCurve = this.toneCurve;
    renderer.pass.pixelRatio = this.pixelRatio;
    return renderer.draw(
      meshes,
      scene,
      camera,
      toneMapped,
      srgbDestination,
      diagnosticMeshes,
      copies,
      this.degraded,
    );
  }
  private release() {
    this.linear?.dispose();
    this.linear = undefined;
    this.display.dispose();
  }
  dispose() {
    this.context.canvas.removeEventListener('webglcontextrestored', this.restored);
    this.release();
  }
}
