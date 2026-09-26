import type {
  AssetScope,
  CameraPose,
  MathPathMode,
  PreparationProgress,
  ScreenErrorVariant,
} from '../../../../sdk-core/src/index.ts';
import type { ComparisonLayout } from '../../measurement/comparison.ts';
import type { BackendDiagnostic, BackendFactory, DiagnosticDetail } from '../../backend/types.ts';
import type { DiagnosticGpuVariant } from '../../diagnostic/gpuVariant.ts';
import type { Object3D } from '../../../../sdk-core/src/world/object/object3d.ts';

/** A named view of a scene a page can jump to. */
export type PointOfInterest = {
  /** The view's short name, unique in its scene. */
  id: string;
  /** The words a page shows for the view. */
  label: string;
  /** Where the camera stands and what it looks at. */
  pose: CameraPose;
};
export interface MeasuredWorldOptions {
  /** Own controls, CSS/DPR sizing and demand-driven rendering. Off by default.
   *  Defaults to direct WebGPU; a missing capability rejects startup. */
  interactive?: boolean;
  /** The engine path that draws. Absent: the best one the machine grants. Forced and missing:
   *  the session is refused by that name, never served the other path. */
  renderer?: 'webgpu' | 'webgl2';
  /** Called before every frame the interactive session draws: the host writes its scene then. */
  beforeFrame?: () => void;
  /** Asked once the camera's reach outgrew the rows a partitioned scene sized when the session
   *  opened: the owner opens the session again, sized for that reach. */
  onRowsOutgrown?: () => void;
  /** False: the interactive session installs no camera controller of its own. */
  ownControls?: boolean;
  /** Called after every frame the session draws, with that frame's metrics. */
  onFrame?: (metrics: import('../../../../sdk-core/src/index.ts').FrameMetrics) => void;
  replicaCount?: 1 | 4 | 9 | 12;
  detail?: 'source' | 'maximum';
  onEvent?: (event: import('../../../../sdk-core/src/index.ts').RuntimeEvent) => void;
  manifestUrl: string;
  scope?: AssetScope;
  signal?: AbortSignal;
  width?: number;
  height?: number;
  fov?: number;
  pixelRatio?: number;
  pageFetchWorkers?: number;
  maxPageTransferBytes?: number;
  onPreparation?: (event: PreparationProgress) => void;
  backends?: BackendFactory[];
  maxResidentPages?: number;
  maxCachedPages?: number;
  /** The decoded-page cache the session reads through, and the CPU total it counts against: the
   *  world's, kept across its sessions, so a session reopened fetches nothing it holds. Set by the
   *  world itself (its CPU total is `world.budget.cpu`); a session without one reads through a
   *  cache of its own. */
  pageCache?: import('../../streaming/pageCache.ts').PageCache;
  pixelError?: number;
  lodAdaptive?: boolean;
  /** Presentation clear color supplied by the host, encoded as 0xRRGGBB. */
  clearColor?: number;
  /** The host's clear colour now, `0xRRGGBB`, `undefined` for none (the default clears): what a
   *  diagnostic compares the pixels with once a background changed in place, `clearColor` being
   *  only the one the session opened on. */
  currentClearColor?: () => number | undefined;
  /** Bounded diagnostics emitted by a backend and owned by the host report. */
  onDiagnostic?: (diagnostic: BackendDiagnostic) => void;
  /** Summary suppresses per-frame trace records; trace is the default with an observer. */
  diagnosticDetail?: DiagnosticDetail;
  preload?: 'visible' | 'all';
  /** Render static prepared pages without requesting the full source geometry buffer. */
  autonomousGeometry?: boolean;
  comparisonLayout?: ComparisonLayout;
  comparisonPair?: [string, string];
  gpu?: GPU;
  /** A WebGPU device the caller holds: the session draws on it instead of requesting its own,
   *  and leaves it alive when disposed — what a world reopening its session keeps. */
  gpuDevice?: GPUDevice;
  pointsOfInterest?: PointOfInterest[];
  /** Texture-tile bytes the WebGPU engine admits per frame; 16 MiB by default. */
  maxTextureTransferBytesPerFrame?: number;
  /** CPU milliseconds the WebGPU engine may spend copying texture tiles per frame; 1.0 by
   *  default. The pass stops after the copy that crosses it; the tiles left wait for the next
   *  frame, shown meanwhile by their coarser resident level; the worst pass is published as
   *  `textureUploadPeakMs`. */
  maxTextureUploadMsPerFrame?: number;
  /** Geometry-page pool bytes — streamed geometry memory, regardless of the scene, like the
   *  reference's 512 MB pool; the WebGPU and WebGL2 engines both hold it. 512 MiB by default.
   *  The root cover always fits; what a view asks beyond that draws coarser, never refused.
   *  Set during the session by `explorer.setMemoryBudgets`. */
  geometryPoolBytes?: number;
  /** Largest geometry pool `explorer.setMemoryBudgets` may ask for during the session —
   *  the maximum of a settings slider. The starting budget without it. */
  geometryPoolCeilingBytes?: number;
  /** Virtual-texture pool bytes of the WebGPU engine — texture memory, regardless of the
   *  scene. 512 MiB by default, split equally between the colour atlas and the data atlas,
   *  in 63.5 MiB layers; under one layer per atlas the pool is raised to one, by name. What
   *  a view asks beyond that waits for a less-looked-at tile to free, and a missing tile
   *  shows its coarse level: the `textureTiles*` metrics publish it. Set during the session
   *  by `explorer.setMemoryBudgets`. */
  texturePoolBytes?: number;
  /** Block compression of the WebGPU texture pools. `'auto'`, the default, takes the format
   *  the device samples among those the cache bakes — BC7 on desktop cards, ASTC 4×4 on
   *  mobile ones —, one byte per texel in the pool instead of four, the same budget holding
   *  four times the tiles; `'bc7'` or `'astc'` insist on one, `'none'` keeps RGBA8, the
   *  lossless "before" of a comparison. Only a texture whose chain the cache baked and kept in
   *  that family reads blocks; a texture with no baked chain, a chain the gate refused or a
   *  cache cooked without the family stays RGBA8 in the lossless lane. */
  textureCompression?: import('../../texture/blockFormats.ts').TextureCompression;
  /** Temporal antialiasing of the WebGPU engine, on by default as in the reference: each
   *  frame is rendered with a fraction-of-a-pixel jitter and accumulated over the previous
   *  ones, reprojected. `false` renders the image sampled at the pixel centre, with no
   *  history — that is the "before" of a comparison, and what pixel-for-pixel benches ask. */
  temporalAntialiasing?: boolean;
  /** The world's effect chain, drawn after temporal antialiasing (`world.effects`). */
  effects?: import('../../../../sdk-core/src/world/effect/chain.ts').EffectChain;
  /** Hears the mode of a surface that keeps WebGL2 from drawing `effects` on a frame, drawn
   *  whole without the chain (`ComposedChain.refused`). */
  effectsRefused?: import('../render/compose.ts').ComposedChain['refused'];
  /** Whether the prepared scene reads the source images. `'cache'`, the default: an image whose
   *  mip chain the cache carries is neither fetched nor decoded — the engine reads the baked
   *  levels, which it does whatever this option says. `'host'`: the scene reads and decodes
   *  every source image, what an engine that draws the host scene (the Three witness)
   *  requires; the engine still reads the baked levels, so such a session pays for the images
   *  twice and asks for them on purpose. `'cache'` holds only where every mounted backend
   *  reads those levels; where one of them samples the host images, the session reads them
   *  as under `'host'` (`resolveTextureSource`). */
  textureSource?: 'host' | 'cache';
  sceneLighting?: Object3D;
  /** Lines and points drawn over the image, held by the world (`world.guides`). */
  guides?: import('../../guides/guideSet.ts').GuideSet;
  /** Particle pools, held by the world (`attachParticles`). */
  particles?: readonly import('../../../../sdk-core/src/fluids/particles.ts').ParticlePool[];
  /** Hears, once per refusal, why the renderer refused the `particles`; the session goes on. */
  particlesRefused?: (reason: string) => void;
  /** Hears a surface WebGL2 draws without a physical feature, held by the world
   *  (`noticeMaterialDegraded`). */
  materialDegraded?: import('../../webgl/cluster/validation.ts').MaterialDegraded;
  /** Bounced light. Off by default; `true` turns it on for the whole session. */
  bounce?: boolean;
  /** Target duration of the "Bounce" step per frame, in milliseconds. 0.8 ms by default. */
  bounceBudgetMs?: number;
  /** Time every step of the frame and publish `explorer.stageProfile()`. Off by default. */
  stageProfile?: boolean;
  /** A GPU DIAGNOSTIC variant (`../../diagnostic/gpuVariant.ts`): it neutralises a factor of the
   *  frame to split its duration, and therefore renders an image different from production.
   *  Absent by default; refused outside `diagnosticDetail: 'trace'`. */
  diagnosticGpuVariant?: DiagnosticGpuVariant;
  /** Page-by-page shadow-map invalidation. On by default; `false` restarts the whole face
   *  as soon as an object moves in its range, as before the virtualized-shadows batch. */
  shadowPageInvalidation?: boolean;
  /** Declare the lights the source file carried, read from the cache. On by default: an
   *  imported scene arrives with its lights. `false` opens the scene with none of them. */
  importedLights?: boolean;
  /** Path of batched compute operations: `'auto'` by default, measurement arbitrating
   *  between reference JavaScript and the WebAssembly module. `'js'` or `'wasm'` impose it
   *  for a campaign; `'wasm'` falls back on `'js'` where the module is missing, and says so
   *  in the metrics. */
  mathPath?: MathPathMode;
  /** Measurement EXPERIENCE (`sdk-core/screenErrorVariant.ts`): the cluster screen-error
   *  metric. `'certifiee'` by default, ours; `'reference'` puts the simple projection of the
   *  external reference, CPU and GPU to the same result to f32. */
  screenError?: ScreenErrorVariant;
  logInterval?: number;
}
