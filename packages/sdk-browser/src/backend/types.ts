import type { HostDiagnosticFactory, HostScene, HostTexture } from '../host/resources.ts';
import type { HostCamera } from '../camera/world.ts';
import type { HostDrawOutput } from '../webgl/core/renderTarget.ts';
import type {
  BackendCapabilities,
  ClusterManifest,
  DiagnosticMode,
  SceneLightStore,
  StageProfile,
} from '../../../sdk-core/src/index.ts';
import type { BackendDrawCounters, BackendMetrics } from '../diagnostic/metricKeys.ts';
import type { SceneToneMapping } from '../../../sdk-core/src/scene/core/environment.ts';
import type { MemoryBudgets, MemoryBudgetsReport } from '../residency/pools.ts';
import type { CpuStepSummary } from '../stage/cpuProfile.ts';
import type { BackendDiagnostic, DiagnosticDetail } from '../diagnostic/types.ts';
import type { PlacementRows } from '../placement/rows.ts';
import type { BackendSceneUpdates } from '../placement/backendSceneUpdates.ts';
import type { BackendHostDraw } from './hostDraw.ts';
import type { Object3D } from '../../../sdk-core/src/world/object/object3d.ts';
export type { BackendCapabilities, BackendDiagnostic, DiagnosticDetail, HostDrawOutput };
type ViewSize = { width: number; height: number };
export interface RenderBackend extends BackendSceneUpdates, BackendHostDraw {
  id: string;
  capabilities: BackendCapabilities;
  setDiagnostic?(mode: DiagnosticMode): void;
  /** The host builders a view needs to repaint `scene`, declared by an engine that has no
   *  `setDiagnostic` of its own: making a host object belongs to the boundary that owns the
   *  graph, never to the view. Absent from an engine that paints its own diagnostic. */
  hostDiagnostics?: HostDiagnosticFactory;
  refreshSceneLighting?(): void;
  /** True when the rendered scene carries at least one declared light; false is the unlit view,
   *  whose composition is identity (P6). Read every frame: a light added later changes it. */
  sceneLit?(): boolean;
  /** The display curve the scene chose; ACES when absent. Read every frame, like `sceneLit`. */
  sceneToneMapping?(): SceneToneMapping;
  /** The contract light store has changed: the next frame will reread it. Absent = lights ignored. */
  refreshSceneLights?(): void;
  /** What no signature says about this engine's lighting: its shadows, and the phrase that names
   *  what it does not apply. The rest of the capabilities is read from the present methods; see
   *  `lightingCapabilitiesOf`. Absent from an engine that has nothing more to declare. */
  lighting?: { shadows: boolean; reason?: string };
  /** Moves a named node of the prepared scene; applied to the next frame, without allocation (R8). */
  setTransform?(nodeName: string, matrix: Float32Array): void;
  /** Sets memory pools during the session; returns what the engine holds afterwards. */
  setMemoryBudgets?(budgets: MemoryBudgets): Promise<MemoryBudgetsReport>;
  signal?: AbortSignal; // Aborted by its dispose or its session's: `prepare` then fails as cancelled.
  prepare(): Promise<void>;
  render(camera: HostCamera): void;
  readonly overBudget: boolean;
  /** True when the last rendered frame was held: nothing was reselected or rebuilt, and the
   *  attached scene IS this frame. Read per frame; absent from an engine that holds nothing. */
  readonly frameHeld?: boolean;
  scene: HostScene;
  /** Canvas the engine presented its image into, when that canvas is not the host's own surface:
   *  a host composing elsewhere copies it (`createBackendPresenter`) instead of drawing `scene`.
   *  Absent from an engine drawing on the host surface itself, and withdrawn — canvas blanked —
   *  by a lost or disposed device before the next call raises `WEBGPU_LOST`: no host composes a
   *  frame older than the device. */
  readonly presentedSurface?: HTMLCanvasElement;
  metrics(): BackendMetrics & BackendDrawCounters;
  /** Per-step profile of the sliding window: CPU and GPU durations kept separate.
   *  Absent from an engine that does not hold one; `enabled: false` when the host did not ask. */
  stageProfile?(): StageProfile;
  /** Forgets the profile window: warmup and the first frames no longer weigh on its quantiles. */
  resetStageProfile?(): void;
  /** CPU bounds of the images since that reset, read once then forgotten; `null` with no row. */
  cpuSteps?(): CpuStepSummary | null;
  /** Shadow-atlas fingerprint, bit for bit: the proof of drawing by pages, never an image. */
  shadowAtlasDigest?(): Promise<import('../gpu/shadow/digest.ts').ShadowAtlasDigest | null>;
  /** What the GPU partition of the last frame wrote, and the inputs it drew it from: the proof,
   *  cluster by cluster, that its rectangles and depths are conservative. */
  partitionAudit?(): Promise<import('../webgpu/core/partitionAudit.ts').PartitionAudit | null>;
  /** What the transparent occlusion test rejected, and the depth it rejected against: the proof
   *  that no removed cluster would have written a pixel. */
  transparentOcclusionAudit?(): Promise<
    import('../webgpu/transparent/occlusionAudit.ts').TransparentOcclusionAudit | null
  >;
  pendingUrls?(): string[];
  /** Bundles a finer cut would need. Fetched at low priority while the network is otherwise idle,
   *  so a small camera move finds them already resident. */
  prefetchUrls?(): string[];
  pageUrls?(): string[];
  /** The same pins as `pageUrls`, spoken as a difference of request ranks: the host no longer has
   *  to rebuild a set of strings every frame. An engine that does not implement it keeps `pageUrls`. */
  retainedRanks?(): import('../streaming/types.ts').HostRetentionDelta;
  /** The catalogue integer sheet for a request: what off-thread integration plans. */
  pageSpecs?(url: string): Int32Array | undefined;
  acceptPage?(
    url: string,
    array: Uint32Array,
    plan?: import('../page/integration/host.ts').ArrivalPlan,
  ): void;
  acceptGeometryPage?(
    url: string,
    data: import('../page/decode/geometryPage.ts').DecodedGeometryPage,
  ): void;
  dropPage?(url: string): void;
  /** Bytes of the engine's CPU cut tables now, sized by the view and the pool: the CPU total holds
   *  them beside the decoded pages (`../residency/memoryBudget.ts`). */
  hostTableBytes?(): number;
  syncResident?(): void;
  flush?(options?: { image?: boolean }): Promise<void>; // image: false skips the readback
  /** Wait for submitted work without image readback; true asks for another interactive frame. */
  pendingFrame?(): Promise<boolean>;
  /** Current GPU image, bottom-left origin. Prefer flush() first; browser hosts can explicitly read synchronously. */
  capture?(): Uint8Array;
  /** The composed image of `camera` at a size of its own, drawn aside: nothing is presented. */
  captureColorView?(camera: HostCamera, size: ViewSize): Promise<Uint8Array>;
  captureSurfaceView?(
    camera: HostCamera,
    options: { width: number; height: number; signal?: AbortSignal },
  ): Promise<import('../scene/surfaceBuffer.ts').SurfaceCapture>;
  rasterRgba?(): Uint8Array;
  visibilityIds?(): Uint32Array;
  dispose(): void | Promise<void>; // A release that finishes later resolves when it has.
}
export interface BackendContext {
  source: Object3D;
  metadata: ClusterManifest;
  indices: Map<string, Uint32Array>;
  /** Node → primitive; `placements`, the instance rows drawn in place of its pose (`rows.ts`). */
  associations: Map<Object3D, { meshes?: number; primitives?: number; placements?: PlacementRows }>;
  /** glTF rank of each texture of the prepared scene, to tie an atlas layer to its preview. */
  textureIndices?: Map<HostTexture, number>;
  /** Reader of texture levels baked in the cache; absent from a cache that has none. */
  readTextureLevel?: import('../texture/levelReader.ts').TextureLevelReader;
  signal?: AbortSignal;
  maxResidentPages?: number;
  /** What host-memory engines keep resident without a host ceiling; the WebGPU pool is in bytes. */
  residentPagesDefault?: number;
  maxCachedPages?: number;
  pixelError?: number;
  lodAdaptive?: boolean;
  /** Presentation clear color supplied by the host, encoded as 0xRRGGBB. */
  clearColor?: number;
  /** Bounded diagnostics emitted by a backend and owned by the host report. */
  onDiagnostic?: (diagnostic: BackendDiagnostic) => void;
  /** Named at each step preparation awaits: what an opening that never ends is waiting in. */
  preparationStep?: (step: string) => void;
  /** Summary suppresses per-frame trace records; trace is the default with an observer. */
  diagnosticDetail?: DiagnosticDetail;
  viewport?: [number, number];
  /** Image pixels per CSS pixel, read each frame: the host's `pixelRatio`, which a resize may
   *  change. A line's `linewidth` counts CSS pixels, as the reference's `LineMaterial` does. */
  pixelRatio?: () => number;
  gpuDevice?: GPUDevice;
  gpuCanvas?: HTMLCanvasElement; // a host canvas dedicated to this WebGPU backend
  /** Engine-owned host context. WebGL backends may allocate resources on it but never replace it. */
  webglContext?: WebGL2RenderingContext;
  /** Texture-tile bytes and tile-copy CPU milliseconds admitted per frame; the rest waits. */
  maxTextureTransferBytesPerFrame?: number;
  maxTextureUploadMsPerFrame?: number;
  /** Geometry-page pool bytes, fixed regardless of the scene; 512 MiB by default. The root cover
   *  always fits; the rest draws coarser when it does not fit. Image targets follow resolution.
   *  The ceiling: the largest pool `setMemoryBudgets` may ask for, the starting budget without
   *  it; per-drawable-page tables are sized once, to it. */
  geometryPoolBytes?: number;
  geometryPoolCeilingBytes?: number;
  /** Virtual-texture pool bytes, shared by the colour and data atlases; 512 MiB by default. A
   *  view beyond it waits for a less-looked-at tile, a missing tile shows its coarse level.
   *  `textureCompression`: the pools' block family, `'auto'` what the device samples. */
  texturePoolBytes?: number;
  textureCompression?: import('../texture/blockFormats.ts').TextureCompression;
  /** Temporal antialiasing, on by default as in the reference: `false` renders the
   *  image sampled at the pixel centre, with no jitter and no history — the "before" of a comparison. */
  temporalAntialiasing?: boolean;
  /** The world's effect chain, drawn after temporal antialiasing; absent or empty, nothing is. */
  effects?: import('../../../sdk-core/src/world/effect/chain.ts').EffectChain;
  sceneLighting?: Object3D;
  /** The world's guides, drawn over the image, and its particle pools, stepped once per image. */
  guides?: import('../guides/guideSet.ts').GuideSet;
  particles?: readonly import('../../../sdk-core/src/fluids/particles.ts').ParticlePool[];
  /** Hears once why the engine refused the `particles`; the session goes on without them. */
  particlesRefused?: (reason: string) => void;
  /** Contract lights, owned by the host and shared by every engine of the session. */
  sceneLights?: SceneLightStore;
  /** Imported light ids, in cache order: the host sets or removes them (`importedLights()`). */
  importedLightIds?: string[];
  /** Bounced light, off by default: its step stays above the measured one-millisecond bar.
   *  `bounceBudgetMs`: its GPU target per frame, `BOUNCE_SETTINGS.budgetMs` (0.8 ms): a target. */
  bounce?: boolean;
  bounceBudgetMs?: number;
  /** Time every step of the frame. Off by default: only the bench and the harness turn it on. */
  stageProfile?: boolean;
  /** DIAGNOSTIC variant kept by the host, checked (`../diagnostic/gpuVariant.ts`); absent in production. */
  diagnosticGpuVariant?: import('../diagnostic/gpuVariant.ts').DiagnosticGpuVariant;
  /** Page-by-page shadow-map invalidation, on by default. */
  shadowPageInvalidation?: boolean;
  /** Reads the resident-proxy cache object. Absent when the cache does not carry one;
   *  called at most once, on the first frame that carries a declared light. */
  readSceneProxy?: () => Promise<import('../../../sdk-core/src/index.ts').SceneProxy>;
  /** Host-owned, validated page reader for the initial complete GPU fallback. */
  readPage?: (url: string) => Promise<Uint32Array>;
  readGeometryPage?: (url: string) => Promise<Uint8Array>;
  /** The session's one integration budget per frame (`frameBudget.ts`); absent, nothing bounds it. */
  frameBudget?: import('../page/integration/frameBudget.ts').FrameClock;
}
export type BackendFactory = (context: BackendContext) => RenderBackend;
export type { MeasuredWorldOptions, PointOfInterest } from '../world/session/options.ts';
