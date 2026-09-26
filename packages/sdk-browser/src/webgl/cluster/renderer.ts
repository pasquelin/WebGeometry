import {
  drawPasses,
  isClusterDrawMesh,
  drawTriangles,
  drawWorld,
  type ClusterDrawMesh,
  type HostAttributes,
  type WholeMesh,
} from '../../cluster/batchMesh.ts';
import { WebglClusterGeometry } from './geometry.ts';
import { WebglClusterTextures } from './textures.ts';
import { unsupportedClusterLight, WebglClusterLights, type WebglClusterScene } from './lights.ts';
import { WebglClusterState } from './state.ts';
import { TONE_MAPPING_RANK, normalMatrix3 } from '../../../../sdk-core/src/index.ts';
import { multiplyMatrix4Typed } from '../../../../sdk-core/src/math/matrix/matrix4Typed.ts';
import type { HostDrawCamera } from '../../camera/world.ts';
import { Matrix3UniformCache, setClusterSamplers, setMatrix3 } from './uniforms.ts';
import { WebglClusterMaterialUniforms } from './materialUniforms.ts';
import { createClusterProgram } from './program.ts';
import { validateClusterMeshes, type MaterialDegraded } from './validation.ts';
import { WebglClusterBackdrop } from './backdrop.ts';
import { BACKDROP_UNITS, ClusterMaterialPass, type Material } from './materialBinding.ts';
import { refuseCluster } from './refusal.ts';
import { WebglClusterCopies, type SceneCopy } from './copyCulling.ts';
import { submitClusterMesh, submitDiagnosticMesh, type MultiDraw } from './submit.ts';

type Drawn = ClusterDrawMesh | WholeMesh;

export class WebglClusterRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private geometry: WebglClusterGeometry;
  readonly textures: WebglClusterTextures;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private normal = new Float32Array(9);
  /** Model-view in double precision, the normal matrix read from it; the program gets floats. */
  private modelView = new Float64Array(16);
  private modelViewUpload = new Float32Array(16);
  private lights: WebglClusterLights;
  private state: WebglClusterState;
  private validated = new Map<Material, HostAttributes>();
  private multiDraw: MultiDraw | null;
  private backdrop: WebglClusterBackdrop;
  private copies = new WebglClusterCopies<SceneCopy>();
  /** Triangles submitted by the last frame, every pass and the backdrop's included. */
  triangles = 0;
  /** Whether the program last read placement matrices; `undefined` until the first mesh. */
  private instanced: boolean | undefined;
  /** Submissions of the scene copies in view, over both passes of the last frame. */
  copySubmissions = 0;
  /** Cluster submissions of the last frame's backdrop pass; zero without a transmissive copy. */
  backdropSubmissions = 0;
  /** Whether the last frame drew the backdrop pass: its submissions are the display pass's again. */
  backdropPasses = 0;
  /** The display curve's rank (`TONE_MAPPING_RANK`), written by the owner before a frame. */
  toneCurve: number = TONE_MAPPING_RANK.aces;
  degraded: MaterialDegraded | undefined; // written by the owner before a frame, as `toneCurve`
  readonly pass: ClusterMaterialPass;
  /** The display renderer whose vertex arrays, maps, backdrop and raster state this one shares:
   *  set on the effect chain's linear variant (`createClusterProgram`). */
  private readonly display: WebglClusterRenderer | undefined;
  private readonly locations: Record<string, number>;
  constructor(gl: WebGL2RenderingContext, display?: WebglClusterRenderer) {
    this.gl = gl;
    this.display = display;
    const program = (this.program = createClusterProgram(gl, display?.locations));
    this.locations = display?.locations ?? {};
    if (!display)
      for (const name of ['position', 'normal', 'uv', 'uv1', 'color', 'instanceMatrix'])
        this.locations[name] = gl.getAttribLocation(program, name);
    this.geometry = display?.geometry ?? new WebglClusterGeometry(gl, this.locations);
    this.textures = display?.textures ?? new WebglClusterTextures(gl);
    this.lights = new WebglClusterLights(gl, this.program);
    this.state = display?.state ?? new WebglClusterState(gl);
    this.backdrop = display?.backdrop ?? new WebglClusterBackdrop(gl, BACKDROP_UNITS);
    this.multiDraw = gl.getExtension('WEBGL_multi_draw') as typeof this.multiDraw;
    this.pass = new ClusterMaterialPass({
      uniforms: new WebglClusterMaterialUniforms(gl, (name) => this.at(name)),
      matrices: new Matrix3UniformCache(gl, (name) => this.at(name)),
      textures: this.textures,
      state: this.state,
      linear: !!display,
    });
    gl.useProgram(program);
    setClusterSamplers(gl, (name) => this.at(name));
  }
  /** Bytes the transmission backdrop holds; zero until a transmissive copy is drawn. */
  get backdropBytes() {
    return this.backdrop.bytes;
  }
  private at(name: string) {
    if (!this.uniforms.has(name))
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }
  /** One mesh, every pass its material asks for; a hidden material submits nothing. */
  private mesh(mesh: ClusterDrawMesh | WholeMesh, camera: HostDrawCamera, toneMapped: boolean) {
    const gl = this.gl,
      material = mesh.material as Material;
    if (!material.visible) return 0;
    const record = isClusterDrawMesh(mesh) ? mesh : undefined,
      instanced = !record && (mesh as WholeMesh).kind === 'instancedMesh';
    if (instanced && !(mesh as WholeMesh).count) return 0;
    this.geometry.bind(mesh.geometry, record ? undefined : (mesh as WholeMesh));
    if (this.instanced !== instanced) gl.uniform1i(this.at('instanced'), instanced ? 1 : 0);
    this.instanced = instanced;
    const model = drawWorld(mesh);
    multiplyMatrix4Typed(this.modelView, camera.view, model);
    this.state.applyWinding(model);
    this.modelViewUpload.set(this.modelView);
    gl.uniformMatrix4fv(this.at('modelViewMatrix'), false, this.modelViewUpload);
    normalMatrix3(this.normal, this.modelView);
    setMatrix3(gl, this.at('normalMatrix'), this.normal);
    const passes = drawPasses(material);
    this.triangles += drawTriangles(mesh) * passes.length;
    for (const side of passes) {
      this.pass.bind(material, toneMapped, side, record?.polygonOffsetUnits);
      if (record) submitClusterMesh(gl, this.multiDraw, record);
      else submitDiagnosticMesh(gl, mesh);
    }
    return passes.length;
  }
  private submit(meshes: readonly Drawn[], camera: HostDrawCamera, toneMapped: boolean) {
    let submitted = 0;
    for (const mesh of meshes) submitted += this.mesh(mesh, camera, toneMapped);
    return submitted;
  }
  /** The pass's destination; the raster state is re-applied, the backdrop having written masks. */
  private setOutput(srgbDestination: boolean) {
    this.gl.uniform1i(this.at('srgbDestination'), srgbDestination ? 1 : 0);
    this.state.invalidate();
    this.pass.forget();
  }
  /**
   * One frame: the batches, then whole host meshes — diagnostic pages, plain copies — then the
   * transmissive scene copies, then the blended ones, the order the reference draws a scene.
   * The transmissive copies read the frozen backdrop, so the frame is first drawn into it, in
   * linear light, before the display pass draws it again.
   */
  draw(
    meshes: readonly ClusterDrawMesh[],
    scene: WebglClusterScene,
    camera: HostDrawCamera,
    toneMapped: boolean,
    srgbDestination: boolean,
    diagnosticMeshes: readonly WholeMesh[] = [],
    copies: readonly SceneCopy[] = [],
  ) {
    const gl = this.gl;
    const lightReason = unsupportedClusterLight(scene);
    if (lightReason) refuseCluster(lightReason);
    this.copies.cull(copies, camera);
    const { plain, blended, transmissive } = this.copies;
    validateClusterMeshes(meshes, diagnosticMeshes, this.copies, this.validated, this.degraded);
    gl.useProgram(this.program);
    gl.disable(gl.STENCIL_TEST);
    gl.uniformMatrix4fv(this.at('projectionMatrix'), false, camera.projection);
    gl.uniform1i(this.at('toneCurve'), this.toneCurve);
    gl.uniform1i(this.at('lightCount'), this.lights.upload(scene, camera.view));
    // Units unknown at frame start (the backdrop pass touches only its own); a record follows its
    // host at its first binding, its chain the readers' rule, reread once per image (#42).
    this.textures.beginFrame();
    this.instanced = undefined;
    this.pass.beginFrame(camera, gl.getParameter(gl.VIEWPORT) as Int32Array);
    this.geometry.beginFrame();
    this.triangles = 0;
    let backdropSubmissions = 0,
      copySubmissions = 0;
    if (transmissive.length) {
      this.backdrop.begin(scene.background);
      this.setOutput(false);
      backdropSubmissions =
        this.submit(meshes, camera, false) + this.submit(diagnosticMeshes, camera, false);
      copySubmissions = this.submit(plain, camera, false);
      this.backdrop.end();
    }
    this.backdropPasses = transmissive.length ? 1 : 0;
    this.backdropSubmissions = backdropSubmissions;
    this.setOutput(srgbDestination);
    // The paged clusters and the whole page meshes, in draw order; the copies come after.
    const submitted =
      this.submit(meshes, camera, toneMapped) + this.submit(diagnosticMeshes, camera, toneMapped);
    copySubmissions += this.submit(plain, camera, toneMapped);
    if (transmissive.length) {
      this.backdrop.bind();
      this.pass.forget();
      gl.uniform2f(this.at('backdropOrigin'), this.backdrop.originX, this.backdrop.originY);
      copySubmissions += this.submit(transmissive, camera, toneMapped);
    }
    copySubmissions += this.submit(blended, camera, toneMapped);
    this.copySubmissions = copySubmissions;
    return submitted;
  }
  dispose() {
    if (!this.display)
      for (const shared of [this.backdrop, this.geometry, this.textures]) shared.dispose();
    this.lights.dispose();
    this.gl.deleteProgram(this.program);
  }
}
