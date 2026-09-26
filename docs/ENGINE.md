# Engine internals

How a world draws. A page writes against [SDK.md](SDK.md) and reads what follows through the `world`
families (`metric.frame(world)`, `world.diagnostic.mode`, `capability.lighting(world)`, …). Two
functions below are public, for a standalone host that drives pages or diagnostics itself:
`createGpuPageCache` and `createDiagnosticChannel`, exported by `trillion3d`. Every other internal
name — `openMeasuredWorld`, backend ids, session options — is reachable only through the measurement
entry point (`packages/sdk-browser/src/measurement/measurement.ts`), for the bench, the proofs and the
comparison views, which reach the witnesses through `bench/witnesses/measurement.ts` ([SDK.md, "Entry points"](SDK.md#entry-points)).

## The internal session

A world opens one internal session on itself (`openMeasuredWorld`, `createMeasuredWorldJob`). Its
options beyond `WorldOptions` — `maxResidentPages`, `pageFetchWorkers`, `replicaCount`, `backends`,
`preload`, `comparisonLayout`, `comparisonPair`, `gpu`, `temporalAntialiasing`, `bounce`,
`bounceBudgetMs`, `shadowPageInvalidation`, `importedLights`, `textureSource`,
`textureCompression`, `mathPath` — stay on it; a published world always runs the defaults. The
comparison layouts (`single`, `side-by-side`, `wipe`, `toggle`, `difference`) render two backends to
detached targets with the same camera: a bench and proof tool, never a performance verdict.
`replicateInstances` instances the source 1, 4 or 9 times while sharing geometry and materials, for
the bench.

`RenderBackend.pendingFrame?()` waits for submitted work without image readback and returns whether
interactive rendering should continue; the session owns every interactive listener and pending
callback and releases them on disposal.

## Which backend renders

With no `backends` option, a session renders through the engine's own path. The choice is made once,
before the scene is read, from what the machine offers, and is reported by the `backend-choice`
diagnostic: `origin` (`default` or `host`), `renderer` (the backend id that draws), `autonomous`
(true when the session reads the cache's prepared scene rather than `source.gltf`), the `reason`
that decided it and the `textureSource` it settled on.

| Machine                             | Backend that renders                                                         | Scene file read            |
| ----------------------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| A WebGPU device was granted         | `webgpu-page-raster`                                                         | `source.gltf`              |
| WebGL2, cache with a prepared scene | `autonomous-pages-webgl`                                                     | `metadata.autonomousScene` |
| WebGL2, cache without one           | `autonomous-pages-webgl`                                                     | `source.gltf`              |
| Neither WebGPU nor WebGL2           | none — `NO_ENGINE_BACKEND` (`NO_WEBGL2` from the capability probe before it) | —                          |

`autonomous-pages-webgl` decodes the cache's geometry pages itself, draws every page the cut selects
— `submittedTriangles` equals `selectedTriangles` — and lights the scene from the cache's light
table. The compiler writes a prepared scene only when every primitive is `exact-clusters`; otherwise
the same path takes its materials and placements from `source.gltf` (`autonomous: false`), an image
rather than a refusal. A forced renderer the machine lacks is refused by name, never swapped.
`chooseBackends(options, metadata, gpuDevice, webgl2)` exposes the decision to a bench before a
session opens, and `autonomousCacheReady(metadata)` answers whether a cache carries the prepared
scene. The comparison backends (the witnesses) are opt-in through `backends` and described in
[bench/runner/README.md](../bench/runner/README.md#the-witnesses); the engine never mounts one on its
own.

## Scene and camera

The host subtree is mirrored once into one engine transform tree when the scene index is built; each
later pass enters only the pose numbers the host moved — compared bit for bit against what the tree
holds — and updates only the subtrees that moved, so a node moved out of two thousand costs the chain
under it, not the scene. The pose a page record, a cluster root or a transparent copy carries is a
sixteen-number view on that tree's world buffer: rewritten in place, never copied, never stale. The
local pose of drawn nodes and lights is hooked, so a write increments the scene revision and a frame
compares one integer; visibility, parent and a light's numbers are compared per frame.

What the engine computes — matrices, vectors, colours, its camera, the side of a material — it
builds on `sdk-core`. A resource crosses the host boundary as the shapes of
`packages/sdk-browser/src/host/resources.ts` (`HostMaterial`, `HostTexture`, `HostAttributes`,
`HostMesh`, `HostScene`; a node is the core's `Object3D`) and is read in one place,
`packages/sdk-browser/src/host/surfaceImport.ts`, into the engine's own `Material` and `Texture`
(`packages/sdk-core/src/contracts/material.ts`, `packages/sdk-core/src/texture/contract.ts`). Every
pass, page row, tile pool and transparent item computes on those records alone; a page carries
`PageSurface` (`packages/sdk-browser/src/page/surface.ts`). The material is re-read at every call; a
texture is read once and refilled when the host bumps `texture.version` — and a host that changes
anything a sampler declares (wrap, filter, anisotropy, colour space, UV transform) bumps it too. The
side is re-read at every look; `alphaTest`, `opacity` and the blend flags where they are read;
everything else follows `material.version`. `tests/integration/engine-without-three.test.ts` holds
the closed list of files allowed to reach back into the host object.

The engine does not read the host's clip-depth convention. It composes its own projection from the
declared optics — field, aspect, near plane, zoom — in **reversed depth with an infinite far plane**
(`engineCamera.ts`, `depthConvention.ts`), and that single convention serves the frustum planes, the
view-projection the GPU consumes, the Hi-Z bounds and the CPU visibility raster alike.

## WebGPU page raster

`createGpuPageCache(device, pageSource, { pageBytes, slots })` is a bounded WebGPU buffer and queue
adapter: a live `resize(slots)` that keeps what fits, pins, serialized loads, a reusable staging
buffer and eviction without a device-wide queue fence. `dispose()` aborts in-flight reads and waits
for submitted work. It reports allocation accounting, bytes read and uploaded and evictions; it does
not measure physical VRAM. `httpPageSource(baseUrl)` reads its pages by key over HTTP, one request
per read: the cache asks again as [the SDK guide](SDK.md#files-over-http) says, and its read
diagnostics carry the `details.status` of the `RESOURCE_HTTP_ERROR` refusing one.

`webgpuPagesBackend` (`webgpu-page-raster`) consumes that cache. For opaque pages, a compute pass
selects the camera's drawable resident cut — frustum, `lodScore` and conservative backface cones —
keeping complete coarse coverage until every required child is resident. Draw compaction counts
pages in parallel groups of 64, computes group prefixes and scatters each page while preserving bin
order; the visibility shader vertex-pulls indices from resident slots into a visibility buffer of
packed page and triangle ids. The visibility path issues at most six geometry `drawIndirect`
commands (cull mode × Hi-Z pass). Selection and submission counters stay `null` until the matching
GPU result is read back; asynchronous readback serves streaming and diagnostics and never blocks the
current camera's selection. `capabilities.gpuDriven` denotes this opaque selection-to-draw path, not
a completely GPU-autonomous engine.

**Requests ahead of the camera.** A moving camera's cut also evaluates a view ahead
(`gpu/core/aheadView.ts`, `gpu/dag/shader/aheadWgsl.ts`): the eye moved by its velocity over
`PREFETCH_HORIZON_MS` (250 ms, the time to full detail after a stop), inside a frustum that holds
the current and the predicted one, each side opened by the angle the camera turns over the horizon.
It is one descent: what the camera rejects is tried against the view ahead, never drawn, only
requested, in a lower request tier ranked after every visible request, at most half the readback.
The cut sorts its requests by that rank on the GPU, visible tier first and the larger replacement
error first within a tier (`dagSortRequests`, `gpu/dag/shader/snapshotWgsl.ts`); the host reads
them in that order and ranks nothing.
The host serves those pages through the one residency queue as a lower tier after the camera's and
the light cuts' (`webgpu/residency/lowerTier.ts`): never pinned, never evicting a camera page, and
replaced by an empty list once the camera stops. A still camera sends no view ahead and cuts as
before. Admission starts no page once it has held the main thread for the published share
`STREAMING_FRAME_MS` (1 ms): it yields a task and resumes at once (`page/integration/frameBudget.ts`,
the arrival queue's budget), so a due frame waits on it no longer than the share and the page begun
within it, and a hidden tab, where no frame comes, still loads.
Fetching and decoding stay in workers. WebGL2 keeps its own path (#490).

**Occlusion** is two-phase Hi-Z. Pass 1 draws the rows the previous frame drew that the previous
frame's pyramid does not hide; a pyramid is built from that depth (background at the far plane, min
reduction in reverse-Z); pass 2 retests the withdrawn and previously rejected rows against it. The
previous pyramid only chooses pass 1; the current one is the only judge of what is rejected, and it
is conservative to the ulp (`tests/browser/renders/conservative-gpu-partition.browser.ts`). A test
reads the first mip whose outward-rounded footprint fits 16×16 samples; a bound outside the target
or crossing the near plane is kept. A row kept while the view stands still stays in pass 1 until the
view or a world moves, so a still image converges under the jitter and is held.
`selectVisiblePages` and `applyTemporalHiz` remain the CPU A/A oracles and the fallbacks when compute
is missing or a readback is not yet current. If the visibility pipeline cannot be created, the
untextured page raster remains and Hi-Z stays off.

## Material surfaces

The opaque and masked path writes visibility, then reconstructs material properties into three
`rgba16float` textures and one `r32uint` texture (28 logical bytes per pixel): base colour and
metalness, world normal and roughness, emission and AO, surface flags. Depth is `depth32float`.
Lighting consumes these surfaces and reconstructs world position from depth. Transparency is shaded
separately into the HDR target; a transmissive material (`KHR_materials_transmission` with IOR and
volume) is composed after it by one fullscreen pass on a frozen copy of the lit image, bounded by the
opaque depth. ACES and sRGB conversion happen at final composition, which writes the display value
to the capture target and the canvas in one pass.

The reconstruction runs one pass per **material class**, the published visibility-buffer design,
instead of one program that tests every feature per pixel. A class is the set of features the
resolve would branch on — UV, base map, alpha cut-out, roughness, metalness, occlusion, emissive and
normal maps, vertex normals, double-sidedness, tangents, filtered sampling, vertex colours — a
thirteen-bit word carried by every page row. A vertex-coloured class multiplies the base colour by
the page's `COLOR_0` when its material asks for vertex colours, as the transparent pass and the
WebGL2 path do; geometry read as floats carries its colours at the tail of its UV buffer, which every page-geometry pass binds. A masked surface is cut at base map alpha times vertex alpha, as the reference cuts. Pipelines are compiled at preparation, never on the frame that first draws a class. Each frame
the `Trillion3D material depth` pass writes every pixel's class as an exact depth value, then one full-screen
triangle per present class runs under `depthCompare: 'equal'`, so the hardware keeps that class's
pixels and its fragment stage reads only the maps it has. The `material-classes-ready` diagnostic
lists the classes; the `materials` view colours each pixel by its class. Not done: screen tiles per
class, so a class present anywhere costs one full-screen triangle.

## Temporal antialiasing

The visibility buffer cannot be multisampled; edges are recovered temporally. Each image is
projected with a sub-pixel jitter (Halton (2,3), eight positions, a clip-space translation of the
render matrix only) and resolved by `Trillion3D temporal antialiasing` between the transparent pass and
composition: the image is refiltered on its 3×3 neighbours with a one-pixel Blackman-Harris window,
the history is read where the unjittered centre was in the previous image, clamped to the YCoCg box
of the neighbours and blended in, each side weighted by its inverse luminance. Two `rgba16float`
histories ping-pong (16 bytes per pixel, counted in the frame allocation).

Motion vectors are derived, not rasterised: the visibility buffer names each pixel's page row, the
row names its placement, and the pixel is reprojected through that placement's `previous ·
current⁻¹`, then the previous unjittered view-projection, both anchored on the eye so large
coordinates keep single precision. The background reprojects as a direction.

Two regimes. While something moves — camera, scene, resources, work in flight — the current image
weighs one eighth. When an image is **quiet**, the history is dropped, the jitter restarts at phase
zero and the k-th quiet image weighs 1/k: after sixteen, the held image is the uniform average of
sixteen images of the final state only, so two executions render it bit-identically (`0 px` A/A).
Declared cost: when everything stops, edges stiffen for an image or two before reconverging. The
jitter never reaches the cut: selection, frustum and screen error read the unjittered camera. A
surface capture and a diagnostic view render unjittered and unaccumulated. The pass's own timestamp
means nothing on tile-based GPUs; its cost is read as an envelope difference with
`temporalAntialiasing: false`.

## Effect chain

`world.effects` (`EffectChain`, `packages/sdk-core/src/world/effect/`) is one ordered list of passes
drawn over the image after the temporal resolve and before presentation. Each pass declares its
stage: `before-tone-mapping` passes read the linear radiance, in chain order; `after-tone-mapping`
passes will read the display image (none ships yet). The chain is one object for the world's life,
shared by reference with every session; a change of the chain or of a pass's setting counts one
revision and asks for a frame.

- **WebGPU** (`webgpu/pages/render/encodeEffects.ts`, `effects/webgpuEffects.ts`): between
  `encodeTaaPass` and the composition, which tone-maps whatever view it is handed. Each pass writes a
  full-size `rgba16float` target, two in turn at most. The programs compile in the background on the
  first frame with a pass; until then the image is drawn without the chain and never held, and the
  loop draws it again when they arrive, without restarting the temporal accumulation.
- **WebGL2** (`world/render/compose.ts`, `effects/webglEffects.ts`): with a pass, the composer asks the
  engine for linear radiance (`HostDrawOutput.linear`: no curve, no sRGB transfer, alpha as coverage
  over transparent black) into a half-float target with depth, runs the passes, then one output
  program applies the scene's curve and the sRGB transfer over the background, as the WebGPU
  composition does. That draw goes through a variant of the cluster program
  (`CLUSTER_LINEAR_FRAGMENT`), compiled at the first frame with a pass and sharing the display
  program's vertex arrays and maps: without a chain, the program and its uniforms are the ones
  drawn before the chain existed. Its second output marks, one byte a pixel, the coverage of the
  surfaces whose material skips the curve (`toneMapped: false`); the output program leaves that
  share as drawn. Coverage past one is read as light (`effects/webglOutput.ts`). With a chain, a
  `none`-blended surface covers as an opaque one. Multiply and subtractive filter the background,
  which the linear target does not hold: before it binds the target, the composer asks the engine
  (`BackendHostDraw.linearRefusal`), whose scene draw answers from its own walk of the graph — the
  one walk per drawn image it already made, now at the first of that question and the draw, never
  on a held frame (`webgl/cluster/sceneDraw.ts`, `linearRefusal.ts`). A frame that draws a
  transparent surface in either mode, transmissive or not, is drawn whole without the chain, never
  stopped mid-draw;
  `ComposedChain.refused` hears the mode on each such frame, and the world says
  `effects-refused-blending` once (`noticeEffectRefusal`). A context that cannot render half floats
  draws without the chain.
- **Kinds**: each renderer holds one table from pass kind to implementation (`WEBGPU_KINDS`,
  `WEBGL_KINDS`); a new built-in or the custom pass is one entry. The kinds of a chain share its two
  pass targets; each holds its own resources besides, sized for the passes of its kind — the
  WebGPU bloom gives every bloom pass its own uniform range, read at a dynamic offset.

Parity rules, each held by a unit test: an empty chain adds no pass, no copy and no target — the
frame is composed call for call as without one; a held frame redisplays the image the chain drew and
runs no pass, a changed chain breaks the hold and leaves the temporal accumulation still, as
guides do (the chain runs after the resolve); targets are made at the first frame with a pass, fixed
at the image size, freed when the chain empties, and counted in `gpuFrameTargetBytes` (on WebGL2,
which counts no other target, the chain's alone). The GPU total reserves them on the largest canvas
the budget declares (`world.budget.canvas`, 3840 × 2160 by default: two pass targets, the WebGL2
scene target and the bloom levels, 250.5 MiB, `effectTargetReserve`), sized by the same rule the
renderers count them with (`effects/targets.ts`); the default total grows by that reserve only, from
1 686 to 1 937 MiB, and the geometry and texture pools keep 512 MiB each. A canvas drawn past the
declared one still renders whole, at full resolution: the world's diagnostic channel says
`effect targets over budget` (`effect-targets-over-budget`) with the bytes past the reserve, each
time that excess grows. A diagnostic view and an off-screen capture show the engine's image without
the chain.

**Bloom** (`effect.bloom`, `effects/bloomFilter.ts`) is the physically based one of Jimenez
(SIGGRAPH 2014): six half-size levels at most (a declared value, the publication's), filtered down
with the 13-tap filter, summed back up with a 3×3 tent of `radius` texels, then blended:
`image × (1 − intensity) + Σlevels / levels × intensity`. Every filter is normalised, so each level
carries the image's mean radiance: with no threshold, the total energy is conserved (CPU oracle,
`effects/bloom.fixture.ts`). The WGSL and GLSL programs are generated from one tap table and read
back against the oracle. Bytes: 8 per texel of each level, about a third of the image. Cost per
pass: measured on the frame envelope, not by its own timestamp.

## Direct lighting

**A moving image shades a drawn subset of each pixel's lights.** A moving image weighs every light
of its tile without its shadow (the cheap part) and shades in full, shadow included, four of them. A
light worth a sample's share of the pixel's weight is shaded exactly and leaves the pool; the
remaining samples are drawn along the cumulative weight from a per-pixel offset that advances by the
golden ratio every image, each divided by its probability. The estimate is unbiased, so the history
averages it toward the full sum. A **still** image — the quiet ones, a capture, a diagnostic view —
shades every light of the tile, so the held image is the exact sum, `0 px` A/A.
`metric.frame(world).lightsSampled` says which mode ran. Declared cost: a faint grain on lit surfaces
where lights of different colours overlap, while the camera moves
(`tests/browser/renders/sampled-lighting.browser.ts`). What remains: a spatial denoise before the
history.

**Shadow maps are virtual, and only the pages the image reads exist.** Every shadow light has a
virtual map cut into pages of 128 texels, and one page-table word per virtual page; the pages are
drawn in a pool whose size is a budget fixed at the world's first frame, derived from its screen
(`shadowPoolSide`) and allocated only once a light casts a shadow — a world without one pays neither
its bytes nor its per-frame work. A pixel reads the sun level whose texel is at most its footprint and
more than half of it, so a `64 × 64`-pixel tile on one surface reads at most the 2 × 2 pages it
straddles, and a third more while coarser levels stand in for pages not drawn yet: a frame asks for
at most `⁴⁄₃ · 4 · ⌈2W / 128⌉ · ⌈2H / 128⌉` pages. The pool holds twice that — the report being read
and the next one, which a turn of the camera may renew in full. At 1280 × 720 that is 1 280 pages a
frame, 2 560 held: 51 × 51 = 2 601 pages, a 6 528² depth texture of 163 MiB, as much again for
the static layer once something moves, and half as much for the transmittance layer once a blended
surface casts (8 bytes per 4 page texels, 81 MiB). The atlas stops at the 8 192-texel side every
WebGPU device offers (4 096 pages, 256 MiB, and 128 MiB of transmittance), reached at 1920 × 1080;
the pool is the only limit on the pages a frame holds: what it cannot hold is refused at allocation
and published as memory (`shadowPagesOverflow`, #542), read at the coarser level meanwhile, and
pages are evicted least recently read first. A lamp face's finest mip is 32 × 32 pages (`lampFaceSize`).
The table gives each of the 64 shadow slices (`maxLights`) a fixed window of the largest range a
light needs, a whole sun's 16 × 64 × 64 words (`SHADOW_TABLE_STRIDE`): 2^22 words, 16 MiB
(`SHADOW_TABLE_ENTRIES`), so every shadow-casting light the contract accepts holds its range.
The GPU total's shadow share counts it with the pool (`SHADOW_POOL_BYTES`). Its host mirror — the
words, a change flag per word, the pool's page records and eviction bitset, and the frame's page
list (`admit.ts`) at the largest pool, with the shadow batches' host lists
(`SHADOW_BATCH_HOST_BYTES`), 21.0 MiB (`SHADOW_HOST_BYTES`, summed from `shadowTableHostBytes`,
`shadowPoolHostBytes`, `shadowAdmissionHostBytes` and `batchBudget.ts`, which tests check against
real allocations) — is the CPU total's first share, before the decoded-page cache
(`splitMemoryBudget`).

- **A sun is a clipmap.** Level `L` has texels of `2^L` metres; its window is 64 × 64 pages around
  the camera (`sunLevelPages`), addressed by absolute page modulo the window, so a camera step keeps
  every page that stays inside. Sixteen levels (`sunLevels`) start at the near plane's pixel
  footprint. The depth range is the scene's box along the sun, snapped outward to its own
  power-of-two grid: every caster lies inside, and a small growth changes nothing.
- **A lamp face is a mip chain**: 32 × 32 pages at its finest mip, the pool's own side, down to one
  page. Six faces for a point, one for a spot.
- **The level is chosen per pixel, from its footprint** — the world distance between two adjacent
  pixels at its depth: a sun reads the level whose texel is at most that footprint, a lamp the mip
  whose texel at the point's distance is. A texel is never larger than a pixel where the map offers
  one, near or far, and a caster's error counted in texels is counted in pixels. A page not readable
  yet hands the point to the next coarser level; beyond a sun's last level, the far-shadow ray
  against the resident proxy (`proxy.bin`) answers, deterministic and unaccumulated (the
  `sun-far-shadow` diagnostic publishes its bounds). The PCF taps each find their own page: a tap
  within a texel of a seam compares the four texels of its footprint in their own pages, weighted
  by hand — no seam, no guard band.
- **Receivers mark the pages.** The opaque resolve records each page it reads — a bit per table
  word, tested before the atomic, and a list — and the list comes back in one readback per image,
  as the texture feedback does (`webgpu/shadow/pageRequests.ts`). A page asked for and unmapped is
  allocated from the free list, or from the page least recently asked for, the finest first among
  equals; a page the latest report named is never evicted, and coarse levels are served first.
  Meanwhile the pixel reads the next coarser level. Blend and water surfaces read what the opaque
  pixels asked for, and keep their early depth reject.
- **Every stale page the image reads is drawn, in the frame that marks it** (#489). There is no
  per-frame page cap and no millisecond budget; the list goes the coarsest first, each light's
  floor leading (#525), an order that matters only to a frame its memory guard stops. The cost is
  held by caching — a page is drawn again only when what it holds changed —, never by deferring a
  page and showing a coarse or stale one as current. The frame draws its pages in as many batches
  as the per-batch buffers take (`shadowPagesPerBatch`, 24 pages, in the views one light cut runs
  at once), all in its one command buffer, each batch's buffer writes landing in command order
  (`gpu/shadow/batchWrites.ts`, `webgpu/pages/render/encodeShadowBatches.ts`). What the batches
  add is sized once from the largest pool, never grown, and counted in the memory budget
  (`gpu/shadow/batchBudget.ts`): 4 096 pages in full batches of 24 is at most 171 batches a frame
  (`MAX_SHADOW_BATCHES`), each in at most 24 light views. The staging of every batch but the first
  is 170 × 26 556 bytes, 4.31 MiB, made at the first frame that needs it; the light cut's flag
  words, a word per batch for 4 frames in flight, 2 736 bytes; the CPU cut's commands for 4 104
  faces, 65 664 bytes; the region commands of every batch a sampled frame copies for the cull and
  occlusion counts, 2 × 131 328 bytes — 4.62 MiB of GPU memory in the shadow share
  (`SHADOW_POOL_BYTES`), and 178 KiB of host memory in the CPU total's (`SHADOW_HOST_BYTES`). A
  frame that needs more batches — only when a light cut dropped work and its view limit cut
  batches short — draws 171 and leaves the rest pending: a declared limit, counted in
  `shadowPagesPending`, which is otherwise 0 unless a batch could not be encoded. While pages are
  pending, the list puts the pages stale longest first, so views re-marked every frame cannot keep
  the pages behind them waiting: a page that stays read is drawn within 25 frames at worst (the
  bound, in `admit.ts`). One flag says whether a page is read, the table word's valid bit: a page
  whose depth is wrong is withdrawn (`pool.withdraw`) until its redraw lands, and the pixel reads the
  next coarser level. A light that moves or changes, or a sun whose clipmap moves its projection,
  stales every page it maps, and withdraws them: their depth belongs to the old projection. An
  object that moves, is added or is removed stales only the mapped pages its projected box — where
  it was and where it is — covers, drawn in that frame, so no shadow stitches past poses or outlives
  its caster: a static caster that
  moves withdraws them, since their static layer is wrong; an object already moving leaves them
  read until their redraw lands, since their static layer still holds — a static shadow never
  vanishes while something near it moves. A camera move scrolls the clipmap: the pages still inside
  keep their content, only the pages entering are drawn, and nothing else is staled. A
  representation change
  stales them once the camera rests, and a threshold change only the pages drawn at another
  threshold than the one at rest; both leave them read. A stale page no report names is withdrawn,
  since blend and water read without asking. A page never drawn is not read. A report that names more pages than the pool holds — the pool never
  holds more than a report lists (`shadowRequestCap`) — maps the coarsest, then by table entry — never in the GPU's append order —, and the rest read
  coarser:
  that waits for nothing, and the diagnostic counts it (`shadowPagesOverflow`). A page is drawn
  with its own projection into its physical page — viewport and scissor —, so no other page of the
  pool is touched. `shadowPagesRequested`, `shadowPagesCached`, `shadowPoolPages`,
  `shadowPagesDrawn`, `shadowPagesPending` and `shadowWaitMs` publish the work — the wait, in ms
  and in frames (`shadowWaitFrames`, the direct-lighting diagnostic only), of the oldest stale page
  the image reads, counted only while a report names it (#489);
  `diagnostic.shadowAtlas(world)` returns the pool's raw depth hash. A still scene runs no resolve
  and asks for nothing; the image holds once a report proves it reads only pages drawn.
- **The floor is always current.** Every page a report names asks for its light's floor under it
  too — a sun's last clipmap level, a lamp face's one-page mip —: mapped first, never evicted while
  anything above it is read, and drawn in the frame it goes stale, like every page read. The floor
  covers all the light reaches, so it needs
  no report to know what the view will read: a sun asks every frame for the floor pages its view
  reaches — the camera brings new ones in without any pose —, and a new, moved or reshaped lamp for
  the floor of each face until a report written at its current pose comes back, as if the latest
  report named them: a report from a past pose names only the faces that pose's receivers read.
  So a pixel that falls back past a withdrawn page reads a current floor.
- **A moving light follows within the frame.** A move is a change of what shapes its depth —
  kind, position, direction, range, cone, a rect's frame and size, the emitter radius, whether it
  casts —; an intensity, colour or penumbra change re-poses nothing and withdraws no page. A move
  withdraws every page of its past pose, the floor too, so none is read again before it is drawn
  at the new one: the shading samples every page with the light's current matrices. The frame
  draws them all — its floors and every page the latest report named — at the new pose.

**Moving objects redraw their own casters, never the static set under them.** A placement turns
moving the first time its pose or its row's flag actually changes (`webgpu/shadow/mobility.ts`) —
a pose written again where it stands, or a row inside a written range, is no move — and stays so; from then on the pool
keeps a static layer, a second depth texture the pool's size, allocated at that first move — a scene where
nothing moves pays neither its bytes nor its pass. A page drawn in full writes its static casters
into the layer, then restores itself from it and draws its moving casters over; a page that only
a moving object crossed is restored and gets its moving casters alone, split by one word per row
in the page cull. A still moving object stales nothing; it is never demoted, since a rule that
did would redraw the layer each time a pausing object moved again. A residency flag that drops
and rises within a frame — every row follows the table epoch when a pose moves — is no change
for the shadows: only a flag that differs from the last plan's restales its cluster's pages
(`webgpu/shadow/residence.ts`). On a code-built scene with one ball moving over a static ground,
1280×720, the virtual pages redraw 4.4 pages a frame (6 at most) with one light cut, against 224
pages a frame on `develop`, and the frame after the motion is 0 px from a fresh render of the
same pose.

**Shadow casters are selected from the light.** The pages of one light view a frame draws — a sun
level, a lamp face at one mip — form a run, and every run of the frame is selected by ONE traversal
of the cluster cut: the camera's kernels, pipelines, clusters and residency bits, with flags,
counters and output of its own (`gpu/dag/lightCut.ts`). Each work item — a queued node, a candidate
page, a live cluster — carries its view's index; each view reads its own uniform block and owns its
own per-primitive frustum planes, and nothing carries from one frame to the next; the frame pays the
waits between the cut's dispatches once, not once per view. Each view's drawn clusters land in their
own range of one log, which the light compaction walks view by view. Its budget is fixed: the lists
and queues are the camera cut's size whatever the view count (at most `shadowPagesPerBatch`, since a
view holds at least one drawn page, and at most what the device's dispatch and binding limits hold,
`gpu/dag/lightCutCapacity.ts`); work several views together push past them is dropped. The
pages a batch drew while its cut dropped work are drawn again, and the views one batch draws in are
bisected between the most a batch drew whole and the fewest one dropped with: a bound on a batch,
never on the frame, which draws as many batches as its pages take. A view that wanted a
cluster not resident drew its nearest resident ancestor instead, and every page of that view with
it: those pages, and only that view's, are drawn again once residency changes, not only the pages
over the missing cluster; a batch whose requests were not read — the frame found no report
readback free, or its list was full — draws them again at once (`gpu/dag/lightCutRedraws.ts`,
`light-cut-redraw`). Every batch's cut appends its requests to one list (`VIEW_APPEND`), which the
frame copies once after its last batch into one of two report slots (`gpu/dag/lightCutReports.ts`):
every batch's missing casters are asked for, whatever the batch count. Each frame's flag words ride
in one slot sized for the most batches, four slots made at creation; a frame that finds all four
still read draws its pages again, withdrawn meanwhile. A run's window is the square that bounds its pages, cut in eight by eight cells
of whole pages; a node or cluster that covers no cell a drawn page lies in is dropped. Its error is
counted in the view's texels against the camera's pixel threshold — a texel of the level a pixel
reads is at most that pixel —, and the normal cone is off, since the shadow raster culls no face. The
light's mask is compacted over the same draw items as the camera's, and each page culls that list
against its own box or cone. A caster the light wants and the pool lacks is drawn through its
nearest resident ancestor, by the camera's rule (`page/cut/rule.ts`). What the light cuts
request is a second residency tier, loaded after the camera's pages into slots no one holds and never
pinned. The CPU cut does the same, reading the run's view as a camera (`webgpu/shadow/cpuCasters.ts`);
its casters take rows behind its own (#10, #26).

**A blended surface that asks for it casts a shadow attenuated by its opacity.** By default a
see-through surface casts none, as the reference solution leaves translucent materials: glass,
smoke and a beam of light let the light pass. A material asks with `transparentShadow: true`
(`castsBlendShadow`, `gpu/shadow/transmittance.ts`); a cooked model's materials carry no such flag
and cast none. A blended cluster is drawn by the blend pass and never enters the visibility tables:
to cast, it takes a row of the page table _behind_ the visibility rows, which only the shadow pass
reads (`webgpu/row/blendCasters.ts`). The row follows residency like a visibility row — taken when
the cluster's slot arrives, given back when it leaves — and the pool bounds how many exist; a scene
that blends nothing has none. The light cut finds the cluster at that row (`gpu/draw/lightRows.ts`,
pinned by the host), the CPU cut lists it there, and the same cull draws it. It never writes the pool's depth: it fills the
**transmittance layer** (`gpu/shadow/transmittance.ts`), two textures at half the pool's
resolution — one texel for each 2 × 2 depth texels, addressed by the same pages and page table
(texel / 2): the transmittance, `rgba8unorm`, whose RGB keeps `Π(1 − coverage)`, the coverage being
the material's opacity times its colour map's alpha, and the nearest translucent depth,
`depth32float` like the pool's. Transmittance is low-frequency, and the same PCF filters it. A pass
of its own follows the pool's (`webgpu/pages/render/encodeShadowPass.ts`): each page the pool drew
is cleared to full transmittance and far depth, then draws its list twice, where only the blended
rows survive, from the same shader entry — depth only, depth-tested, for the nearest depth; then
colour only, blended multiplicatively, without depth. Both discard a fragment the pool's opaque
depth hides at all four of its texels. Once the last blended caster has given its row back, the
layer stays and its pages are only cleared: neither draw is encoded. The shadow read multiplies its
filtered PCF result by the layer once, at the footprint's centre (`lighting/direct/shadowWgsl.ts`), since the sixteen taps
lie within one texel of it: the four texels around it, kept within its page, each its transmittance
where the receiver lies behind its translucent depth, filtered bilinearly. A pixel the opaque depth
already darkens fully reads nothing of the layer. A constant opacity gives a constant shadow, two panes multiply, a
receiver in front of a pane keeps its light, and a receiver 2 m behind a pane at a 4 km sun range
is attenuated: the depth is single precision. Blended rows count as moving, so the static layer
keeps depth alone and a restored page starts from full transmittance. The layer exists from the
first blended caster on, 8 bytes per 4 page texels (`shadowTransmittanceBytes`, counted in
`SHADOW_POOL_BYTES`); before, the passes and the read are those of an opaque scene, the read
binding one-texel stand-ins it never samples. One nearest depth per texel: a receiver between two
stacked panes takes both. Each product is kept in 8 bits. Opacity 0 takes no row and casts
nothing; opacity 1 lets no light through. Additive and transmissive surfaces cast nothing yet: the tinted
shadow of transmission is #33's, which colours the same RGB layer. An unpaged blended mesh casts
nothing. WebGL2 has no shadow path, so none of this exists there.

When a colour tile arrives, the shadow pages of the masked surfaces that read its texture are
invalidated, and those alone. A masked cut-out is read at the mip level the reading texel's
footprint selects, in the visibility raster and in the shadow pass alike, and the material
resolution requests the tiles of the sun level each masked pixel's own footprint reads. Known limit: a caster the camera never sees
has no one to request its tiles; the shadow pass then reads the finest tile resident.

`setLightingView(view)` selects what the opaque path outputs: `'lit'` (a world's view), `'unlit'`
(base colour as authored, for geometry benches that compare pixels), `'auto'` (unlit while no light
is declared) and `'bounce'` below.

## Light that bounces

An opaque surface can also receive the light that bounced off other surfaces: dynamic, no baked
lighting, independent of the camera. It rests on a **resident proxy** the compiler writes as
`proxy.bin`: the coarse cut of the DAG whose certified error stays under 5 cm, raised per primitive
until the scene fits 300 000 triangles, plus a BVH and one linear diffuse albedo per triangle. The
threshold reached is published as `proxy.errorMetres`. A cache without a proxy declares the bounce
unavailable.

**Cascades of probes.** Irradiance lives in up to four nested cubes of 16 probes per axis, each
level's spacing doubling, the last fixed in the world and covering the proxy, the finer ones
following the camera. Probes sit on a global lattice and are stored modulo the cube side, so sliding
by one cell invalidates only the entering slab. An occupancy map built from the proxy skips empty sky
and solid cores; a probe buried in a surface or lost in the sky sleeps until a light changes.

**A budget in milliseconds, not in rays.** `bounceBudgetMs` (0.8 ms) is the GPU time the stage
should take; the engine reads the stage's timestamp and corrects the fraction of its ceilings (49 152
probe rays, 16 384 cache cells) the next frame encodes. Convergence stretches; the frame rate never
gives. A probe traces 64 rays against the proxy, reads the outgoing radiance the surface cache holds
where each lands, and accumulates order-2 spherical harmonics with adaptive hysteresis from a frozen
snapshot, so the steady image does not depend on thread order. After sixteen sweeps with nothing
changing, neither pass is encoded: a still scene pays nothing.

**One basis.** The nine coefficients per colour a probe holds are the ones the scene environment
and the WebGL2 light probe hold: same band order (constant, `y`, `z`, `x`, `xy`, `yz`, `3z² − 1`,
`xz`, `x² − y²`), same cosine-lobe factors (Ramamoorthi and Hanrahan 2001). `IRRADIANCE_TERMS`
(`packages/sdk-core/src/scene/core/irradianceBasis.ts`) writes the projection and the evaluation
once as shader text; CPU oracles run that text against a constant sky (`πL` on every normal) and a
single direction (the Legendre band sum). The cascades at their largest — four levels of 16³ probes,
44 floats each, probes and snapshot: 5.5 MiB (`BOUNCE_PROBE_BYTES`) — are counted in the GPU total
after the shadow pool, before the geometry and texture pools (`splitMemoryBudget`).

The deferred resolve adds the interpolated irradiance of the eight surrounding probes, weighted by
the cell, the surface's facing and each probe's measured mean distances, which close leaks through a
wall; where no level reaches, the term is zero. Against the compiler's path tracer
(`trillion3d-oracle`) on a control room, the mean error is 18.6 %, above the 10 % target. The
bounce is **off by default**: its stage costs about 1.1 ms, above the one-millisecond bar. Emission
and transparency are not bounced. `setLightingView('bounce')` outputs the indirect irradiance alone,
the quantity `bench/runner/oracle.ts` compares.

**Mirrors.** With the bounce on, a surface at the roughness floor (0.0525, the clamp every shading
path applies) reflects the scene: the resolve fires one ray along the mirror direction against the
resident proxy, from the origin the sun's far shadow uses, and reads the face it hits in the surface
cache; a ray that leaves the proxy reads the probe irradiance in that direction over π. The radiance
is weighed by the GGX lobe's directional albedo, the magnitude and Schlick share of the table the
rectangular light reads. The water composite reflects through the same function, weighted by its
Fresnel, so the engine has one reflection model (`packages/sdk-browser/src/bounce/reflectWgsl.ts`):
mirror-smooth water, at the floor, traces the proxy; rougher water keeps the blurred probe
irradiance over π it read before, never a sharp image. What a mirror shows is the proxy: its
certified error, one radiance per triangle face, and nothing nearer than one proxy cell along the
ray. A rougher opaque surface, a diffuse or toon one, and every surface with the bounce off add
exactly zero: the
floor is a material threshold, so a roughness map that crosses it shows reflecting and
non-reflecting texels side by side until rough reflections (#33) fill the lobes above it. Screen
traces stay on #31, planar views are #353. WebGL2 has no bounce, hence no reflection.

## Fog

`scene.fog` is a term of the one lighting model, not a post effect: every program that lights a
surface hands its lit colour `L` through the same law before the display chain — the opaque resolve
(`lighting/deferred/shaders.ts`), the blended surfaces (`webgpu/blend/shader.ts`), the water
composite and the WebGL2 program. The pixel reaches the eye as `mix(color, L, T)`, `color` the
radiance the medium scatters toward the eye (exposed and tone-mapped like a surface's), `T` the
transmittance over the distance `d` from the camera's position to the surface point:

- linear, `{ color, near, far }`: `T = clamp((far − d) / (far − near), 0, 1)`;
- exponential, `{ color, density }`: `T = exp(−density · d)`, a uniform medium (Beer-Lambert);
- height fog, `{ color, density, heightFalloff, baseHeight }`: the density
  `density · exp(−heightFalloff · (y − baseHeight))` integrated along the ray in closed form,
  `τ = density · d · (ρ(eye) − ρ(P)) / (heightFalloff · Δy)`, the two densities' mean where the ratio
  would lose its 32-bit precision (Wenzel, SIGGRAPH 2006; Quilez, "Better fog").

One text of the law serves both languages (`lighting/fogShader.ts`). The fog travels with the
environment (`SceneEnvironment.fog`, `packages/sdk-core/src/scene/core/fog.ts`): two `vec4`s behind
the irradiance in the contract light buffer on WebGPU, `fogColor` and `fogLaw` uniforms on WebGL2,
written only when the environment changes. The eye rides with the frame's view: `display.yzw` of the
deferred view, `eye` of the blend view, the view space origin on WebGL2. With no fog the block's mode
is zero and every program returns `L` untouched, one uniform branch per pixel. An unlit material
(basic, matcap) is fogged like a lit one, its colour standing for `L`, as in the reference; a normal
or depth material and the diagnostic views, the unlit view among them, are not. Fog is a view-ray
term, not light transport: a change of fog alone leaves the bounce probes converged (the store's
`transportEpoch`). A world writes the fog with the lights before the next frame,
like exposure; a fog set again, or its colour written through its methods, is heard.
`lighting/fogShader.test.ts` evaluates both shader texts against a numerical integration.
Volumetric fog and light shafts belong to the lighting strategy below.

## Transparent surfaces

WebGPU filters transparent meshes against the camera frustum before uploading their uniforms or
issuing their draws; bounds cover the whole transformed geometry, and `frustumCulled: false` or a
non-finite bound keeps a mesh. `FrameMetrics` exposes `transparentMeshes`,
`transparentFrustumRejected`, `transparentDrawCalls` and `transparentSubmittedTriangles`. There is
no transparent LOD, occlusion culling or sorting. The transparent path is still lit from the source
graph's lights and a fixed ambient (at most 256 visible lights), not by the declared-light store —
the next step of the no-implicit-light rule. A blend surface over the display background is composed
in display space.

## Presentation

A direct WebGPU session configures the host canvas with its own `GPUCanvasContext`; no WebGL context
is created. A mixed session (measurement only) composes on a WebGL2 surface: the engine presents
into a canvas of its own, publishes it as `presentedSurface`, and the host copies it with the
engine's own full-screen program (`createBackendPresenter`). `presentedSurface` is withdrawn, and the
canvas blanked, as soon as the device is lost; the loss is announced once by `gpu-device-lost`
(`reason`: the device's own, `uncaptured-error`, `out-of-memory` or `residency`). Neither path reads
the image back for presentation.

A world keeps its device across sessions, and each session creates through its own handle on it
(`gpu/core/sessionHandle.ts`, `gpu/core/deviceOwners.ts`), which tags every label. `dispose` releases
the handle before anything else, and a released handle is inert: its `create*` throw an `AbortError`,
so a preparation still running stops there (cancelled, torn down once after it stopped), and its
queue writes and submits nothing. From `dispose` on, the backend reads as lost: its audits and
digests answer `null`. The device's error scopes are one stack every session shares: each creation
path closes the scope it opened in every case, an abort included (`gpu/core/errorScope.ts`), so no
scope is left to swallow the next session's errors. What a closed session submitted before may still raise an error:
one that names only closed sessions' objects is a console warning and a `gpu-closed-session-error`
diagnostic (`kind: 'warning'`, `message`) for the live session, or for the next one to claim the
device when none is live. An uncaptured error is otherwise a loss for the live session whose objects
it names, or, naming none, for every live session; running out of memory is reported under
`reason: 'out-of-memory'`.

For every WebGL2-hosted session, `createWebglSurface` creates and owns the context before anything
else: attributes, drawing-buffer size from logical size and DPR, loss and restoration, one release.
Targets, held frame, comparison compositor and presenter are engine objects on that context, and the
frame composer asks each backend to draw its whole image through `drawHostGeometry`.

## Memory

The geometry pool holds `floor(bytes / pageBytes)` slots, the root cover pinned for the backend's
lifetime; the texture pool is split between the colour and data atlases in layers. When a view asks
beyond the geometry pool, the WebGPU cut keeps the host's screen error: the pool loads what fits,
coarsest first, and the surface of what it leaves out is drawn by its nearest resident ancestor
(the cut rule, below). Residency does the coarsening; `coverage-budget` only says that the image
asks for more than the slots hold.

The geometry pool's slots are drawn from what its budget leaves the vertex buffers held beside
them (`geometryBudgetBeside` in `webgpu/pages/io/memory.ts`, the rule the texture pool follows for
its live textures), at prepare once those buffers are allocated and at every resize: the slots and
those buffers never sum past the budget, save a budget under the root cover beside them, which is
raised to that cover by name (`root-cover`). A pool resize (`explorer.setMemoryBudgets`) copies
pages and tiles on the GPU into the new pool — root cover first, then pinned pages, then the most
recent — evicts only what no longer fits, and rebuilds every bind group that named the old pool on
the next image. At prepare a pool is allocated once, under an out-of-memory error scope; at a resize, where the old pool lives until
the copy, the new one is first probed under that scope (`webgpu/residency/poolGrants.ts`). A
refusal halves the pool's bytes and draws it again by its own rule, down to its floor, so the pool
in place is never replaced by an invalid one and what no longer fits is drawn by its resident
ancestors. The world's GPU and CPU totals reach the pools through one fixed
split (`residency/memoryBudget.ts`). The geometry pool can grow up to
`geometryPoolCeilingBytes`, because its per-row tables are sized once at that ceiling. The WebGL2
engine draws its geometry pool by the same rule (`sessionGeometryPool`: slots of the largest decoded
page, page cap and session ceiling). A slot holds one geometry copy: a classic instance
(`addInstance`) holds its own copy of every page, so a page three instances draw fills three slots,
while the records rows place share one. Its cut is drawn on the CPU at the host's threshold, under
the one cut rule below; the pool bounds what the image asks for, never the cut. The image asks for
the wanted cut closed over its groups (`page/cut/groupClosure.ts`), coarsest level first, so a page
never comes before the pages it depends on (`backend/autonomous/requests.ts`). The pool admits that
list in its order while the copies it charges fit its slots, the root cover held beforehand
(`backend/autonomous/pool.ts`); the rest is not asked for, and the cut draws its nearest resident
ancestor instead. A smaller budget is therefore paid in detail, one DAG level at a time, from the
finest down: the image that sees it asks for less, and just before the next cut the pages it drew
but no longer asks for leave, so that cut draws their ancestors (`backend/autonomous/poolOrder.ts`).
`coverageBudgetLimited` says the wanted cut did not fit; a verdict change is queued and published as
`coverage-budget` by `flush`, as on WebGPU, with `requiredSlots` the slots the whole request charges
and `pixelError` the host's threshold. Between two cuts, what the image keeps — the root cover, the
host's pages, what it asks for and what it drew — never leaves; over the slots, the rest leaves
oldest first (`evictOldest`, the page streamer's order). A refinement may hold more for a while: a
resident ancestor drawn in place of a missing page is kept while the pages that replace it arrive,
and leaves with the cut that no longer draws it. Only
the root cover and the pages the host replaced (`replaceGeometryPage`) stay above it; they are
counted as the pages' bytes are, every geometry copy included. No pool is reserved:
`geometryPoolAllocatedBytes` is `null`, and what the pages hold is `geometryAllocationBytes`.
Backends without pools throw `UNSUPPORTED_MEMORY_BUDGETS`.

A region keeps a complete resident representation until every replacement page is uploaded: the
cut rule below draws its nearest resident ancestor meanwhile, never the root cover in its place.
On WebGPU a page enters the pool only after the pages it depends on, the clusters of the group
that replaces it, read from the compiled group links (`webgpu/residency/admission.ts`): loading a
wanted page or a shadow caster brings its missing dependencies first, each after its own, up to
the pinned root cover. The bytes come first: the host's request for a page lists the missing
bundles its bundle depends on (`streams.pages[].dependencies`, [FORMAT.md](FORMAT.md#cluster-dag))
and keeps them retained with the cut, even when the parent is outside it. The compiler refuses a
list that misses a parent's bundle or is not closed, so every page the pool walks has its bytes
requested. Until they arrive, or when a dependency does not fit, the page is not loaded and stays
drawn through its resident ancestor. Both tiers of the residency queue share this one path.

**One cut rule per cluster** (`page/cut/rule.ts`, #486). The GPU cut draws a cluster when it is
resident, its parent group is coarser than the threshold, and either its own error meets the
threshold or the group finer than it is not resident:
`draw(c) = resident(c) && parentError(c) > t && (clusterError(c) <= t || !resident(childGroup(c)))`.
The same expression is compiled into the kernel (`dagMask`) and run by its CPU model
(`gpu/dag/oracle/oracle.ts`); the threshold is always the host's. Residency is read by group
(`page/cut/readiness.ts`): a group counts as resident when every cluster it replaces is, and so is
every group above it — a cluster nothing replaces standing for itself. A group then draws all its
outputs or all its members, never both and never neither, so every surface is drawn exactly once,
by the wanted cluster or its nearest resident ancestor, and a missing page coarsens its own
neighbourhood by one level, never its whole primitive. The host derives both bit sets from the
pool's residency and uploads what changed (`gpu/dag/readiness.ts`). Because a group needs all its
members, the cut asks the cache for whole groups closed upward, the group-mates a view never keeps
included (`page/cut/groupClosure.ts`); otherwise the surface of a group straddling the frustum
or the normal cone would stay one level coarse. Top-down pruning drops a subtree whose error floor
is above the threshold only when none of its clusters has a missing finer group: each culling node
carries that count (`NODE_OPEN`), so the nearest resident ancestor of a missing page is always a
candidate. No frame waits for coverage once the root cover is resident. The CPU cut
(`page/cut/take.ts`) applies the same predicate on the same readiness, kept per placement in view
and moved by the pool's residency feed — the rank journal on WebGPU, the page store's loads and
releases on WebGL2 —, so a still view reads no page and a change reads only the pages that moved
(`page/cut/held.ts`); it prunes its descent on the same open counts, in JavaScript and in its
WebAssembly node walk (`page-codec-wasm/src/cut.rs`) alike; the WebGPU CPU path, its light cuts and
the WebGL2 image draw through it, with no fallback of their own. None of these tables is sized by the
world: the readiness holds the resident pages alone — every other page reads its state with nothing
resident, derived from the DAG —, and the closure, the cut's differences, the residency sets and
the pending set hold what the cut names, all in sparse maps (`page/cut/sparseInts.ts`); a
placement that leaves the view lets its readiness go at the end of the image's cut. A world
sixteen times larger, seen from the same view with the same pool, costs the same bytes
(`page/cut/viewBound.test.ts`).
Shared URLs occupy one slot across instances. Two counters say different things:

| Field            | Meaning                                                                                         | Reported by          |
| ---------------- | ----------------------------------------------------------------------------------------------- | -------------------- |
| `pagesDetached`  | clusters that left the drawn cut since the backend was created: cut churn, not memory pressure  | the WebGL page paths |
| `cacheEvictions` | pages actually evicted from the cache that feeds the drawn geometry: the memory-pressure signal | every backend        |

`coverageReady`, `coverageBudgetLimited` and `streamingError` report coverage;
the `coverage-*` diagnostics trace bootstrap, budget, upload and streaming failures. A failed URL is
retried at most three times per session; an initial cover read failure rejects preparation.

## Virtual textures

Material textures are virtual: every texture is cut into 128×128 tiles (plus a 4-texel border) that
live in two fixed pools (sRGB colour, linear data); one page table per texture says which pool tile
serves each tile of each mip level, and only the tiles the image reads are resident. The texture
pool (512 MiB by default, split evenly, in layers of 30×30 tiles) is the session's texture memory
whatever the scene. Residency is driven by the rendered image: the material resolution counts, for
one pixel in sixteen (every pixel during `flush()`), the tile each map needs at the mip its
derivatives select; transparents write their requests into their own target, reduced by a compute
pass. The counters come back one frame late.

Uploads are bounded twice per frame: `maxTextureTransferBytesPerFrame` (16 MiB) and
`maxTextureUploadMsPerFrame` (1.0 ms), most-requested tiles first; the rest waits and shows its
coarser resident level, so a cold traversal streams at a fixed cadence instead of stalling the
frame. The first tile of a pass is always copied. `textureUploadPeakMs`, `textureUploadMs` and
`textureTilesDeferred` publish the work; a stutter is read on the peak and the p95, never on the
median. A full pool evicts the least recently read tile; a tile nothing can accommodate is counted in
`textureTilesRefused`. A missing tile is served by its finest resident ancestor, down to the
texture's tail (every level of 64 texels or less, pinned at `prepare()`): never a fill texel.
`flush()` renders the pose until nothing it reads is missing, drains the pending shadow pages, and
replays the temporal accumulation identically, so a flushed pose is deterministic (`pose-settle`
diagnostic).

**The engine reads the levels the compiler baked.** As soon as the cache declares texture chains,
each baked level is read on demand (decoded by the browser, held within `world.budget.cpu` and
kept across a device loss) and tiles are cut from it. A chain is generated at run time only for a texture the cache carries none for.
`textureSource` (`'cache'` by default) says whether the prepared scene reads the source images: under
`'cache'` an image whose chain the cache carries is never fetched; `'cache'` is honoured only where
every mounted backend reads the baked levels, and `backend-choice` publishes what was settled.

**Block-compressed lanes.** Each atlas is one pool per lane: `lossless` (RGBA8), `rgba` (BC7 or ASTC
4×4) and `two-channel` (BC5 or ASTC luminance-alpha — a normal map's X and Y, Z rebuilt).
`textureCompression` (`'auto'` by default, `'bc7'`, `'astc'`, `'none'`) names the family sampled:
`'auto'` takes the first family the device samples and the cache holds kept chains in, RGBA8 when
none. A texture takes the lane its chain was **kept** in by the compiler's quality gate
([FORMAT.md](FORMAT.md#textures)); a chain the gate left lossless, a partial chain or a host image
reads from the lossless lane, so the engine never trades a pixel for memory on its own. Every lane
with textures gets one layer, the rest of the budget by the bytes its tiles would take.
`texturePoolFormat`, `texturePoolLayers` and `texturePoolBytes` publish the result, and the
`material-textures-ready` diagnostic lists each pool.

## Physics

Jolt Physics (MIT, pinned submodule `packages/physics-jolt-wasm/JoltPhysics`) is compiled with
emscripten and SIMD into one standalone module, `joltPhysics.wasm`, behind this repository's own
flat C API (`packages/physics-jolt-wasm/src/`): one `jolt_step` call reads a command buffer and
writes a pose buffer and an event buffer. No emscripten glue is kept; the engine's loader
(`physics/joltModule.ts`) gives the module its memory, whose maximum is the memory budget.

- **Cooked shapes.** `RESTORE` carries a shape's Jolt binary state (`src/blob.h`, the stream the
  compiler's cook writes) under a handle, an `ADD` of kind `cooked` names the handle, and `RELEASE`
  drops it: the body keeps the shape. `physics/tiles.ts` streams a compiled model's tiles this way,
  `physics/raycast.ts` asks `jolt_cast` (a batch of rays and shape sweeps, between two ticks) for
  `world.raycast(at, { exact: true })`.
- **Worker.** `physics/physicsWorker.ts` steps at a fixed 60 Hz, at most four catch-up steps a
  tick (beyond, time is dropped: slow motion, never a spiral). Two result buffers go back and forth
  as transferables and a tick writes straight into a free one (`tickResults.ts`); when the page
  holds both, its results wait in a staging copy. It steps only while one more step's events fit,
  so no event is cut. With every body asleep and no command queued, the worker stops ticking.
- **Layouts.** `sdk-core/src/physics/layout.ts` (`PHYSICS_LAYOUT_VERSION`) holds the command,
  pose and event word layouts the module mirrors; the page and the worker check the protocol.
  Every record names its body by an engine id, the slot and the slot's generation (moved on at
  each add and removal), so a late record of a body that left is never read as the one in its
  place, on the page or in the module's pair map.
- **Contacts and failures.** The module counts sub-shape contacts per pair: an `enter` is sent on
  the first, a `leave` on the last, and only for a pair whose `enter` was sent; a `leave` the
  event buffer cannot take waits for the next step, and a removed body's pairs are closed as it
  leaves. A shape Jolt cannot build fails its body alone (the page retires it and names it);
  `PhysicsSystem::Update`'s errors (body pairs, contact constraints, manifold cache) are sent as
  `PHYSICS_BUDGET`, their capacities being `budget.physics.bodyPairs` and `contactConstraints`.
- **Page.** `physics/session.ts` reconciles bodies with the scene once per frame that changed it,
  draws each moving body between its last drawn pose and the tick's pose (`poses.ts`), sends the
  view, and posts the frame's commands in one message. A tick is drawn over the interval at which
  ticks arrive, not the time it simulates, and a late one is extrapolated from the linear and
  angular velocities of its records, one interval at most: a slow worker shows slow motion, never
  a held frame. Receive and draw are typed-array loops: a body's node keeps its position,
  quaternion and scale in the placer's flat arrays (`ObservedComponents._share`), its velocity and
  sleep are read from the session's arrays when asked (`ObjectPhysics._state`), each frame lerps from the
  pose drawn toward the tick's, and the pose is written into the transform tree, the angles
  derived when read (`placer.ts`); each body's world matrix is composed straight into the row of
  the instance buffer the renderer draws it from (`SceneLink.seat`), and the world hears the
  written span of each buffer once (`SceneLink.placed`), so no per-node world update runs. A body
  with no row, with children, or under a moved scene root goes through `SceneLink.posed`, which
  recomposes it like any moved node. A pose sent again unchanged asks for no frame, so a
  sleeping world draws nothing.
- **Distance and view.** The page sends its eye, facing, view cone and range (`camera.far`) only
  when they change. In the module, a dynamic body beyond the range is deactivated with its
  velocities kept; a body out of the cone or hidden sends no pose until it is seen again.
- **Budgets.** Bodies, static triangles and decorative bodies are counted on the page; memory is
  enforced by the module's memory maximum; body pairs, contact constraints and events size the
  module's own buffers.
- **Timing.** The `physics` stage of `WEBGPU_STAGES` / `WEBGL_STAGES` (host step `physicsMs`) is the
  page's share; the worker's per-step time is reported apart, in `world.physics.stats.stepMs`
  (the module's step alone, the clock `scripts/bench-physics.ts` reads in Node).
  Its GPU column is the particle step (`Trillion3D particles`, `particles/webgpuParticles.ts`).
  On WebGL2 the same pools step in a 32-bit float ping-pong pass (`particles/webglParticles.ts`);
  a context without `EXT_color_buffer_float` refuses them (`PARTICLES_UNSUPPORTED`).
- **Threads.** On a cross-origin isolated page the page loads `joltPhysicsThreads.wasm` (atomics,
  bulk memory, shared memory) and Jolt's own thread pool steps it: each pool thread starts in C
  through `pthread_create`, which the loader (`physics/joltThreads.ts`) answers with a worker that
  instantiates the same module on the same memory, sets its stack and thread-local storage, and
  runs the entry point. `budget.physics.threads` fixes the count, capped at the logical cores
  minus the page's own; elsewhere the single-threaded module runs. `docs:serve` answers with COOP
  `same-origin` and COEP `credentialless`; the production server's headers are set outside this
  repository. `scripts/bench-physics.ts` steps the example's scene in Node on both modules and on
  the same C API compiled natively (`packages/physics-jolt-wasm/bench/`), with a per-phase profile
  from Jolt's own scopes in a profiled build.

## Diagnostics and timing

`diagnosticDetail: 'trace' | 'summary'` controls event detail; an `onDiagnostic` observer defaults to
trace, and omitting it disables collection. Debug frames are marked `measurementKind: 'diagnostic'`:
turn debug off before collecting performance evidence. Events carry a session id, a monotonic
sequence and a timestamp; delivery is queued outside the measured call, with a 65 536-event pending
limit and an explicit `diagnostic-loss` record on overflow (`createDiagnosticChannel`: `flush()`,
`flushSync()`, `pending()`, `dropped()`). Every SDK build records the SHA-256 of its distributed
modules in its configuration event; a direct source import has `hash: null`.

Phases carry `pipelineVersion: 1`: `gpu-presentation`, `frame-allocation`, `material-textures`,
`material-textures-ready`, `material-classes-ready`, `material-surfaces-ready`, `scene-lighting`,
`render-capabilities`, `render-progress` (selected and resident pages, triangles, pending pages,
transparent counters), surface-capture phases, `gpu-device-lost`, `gpu-closed-session-error`
(`kind: 'warning'`: an error of a session already closed on the same device, never a loss). Observer exceptions cannot
interrupt a backend. These durations are not frame-performance measurements.

**GPU timing.** `timestamp-query` is requested when the adapter advertises it (`gpu-timing-status`).
Summary mode instruments at most one submission in 60, trace mode every one, with one outstanding
readback, and as many pass pairs as the frame that redraws the largest shadow pool encodes: 256
passes plus 32 for each of 171 shadow batches (`gpu/timing/queries.ts`), in query sets of 4 096
timestamps, so shadow GPU time and its cull and raster split are never truncated by the batch
count; `flush()` publishes `gpu-timing` events outside the beauty loop.
`sumPassMs` sums pass intervals; it is not end-to-end GPU latency, and invalid or truncated passes
make it `null`. A per-pass duration says where, never how much: on tile-based GPUs passes overlap.

**CPU timing.** `cpu-timing` reports render duration, light updates, selection, residency and target
management, encoding and submission; `transparentEncodeMs` is a subset of `encodeSubmitMs`, never
added to it. CPU and GPU times are never added together.

**Surface capture for global illumination.** `explorer.captureSurfaceView(pose, { width, height,
signal })` returns an owned `SurfaceCapture` version 1 — the four material textures, depth, inverse
view-projection, camera position and selected triangle count — for future lighting work. It reuses
the page cache, selects for the requested camera, restores the main view afterwards and must be
serialized with ordinary rendering; translucency is excluded.

## Proofs

`pnpm run test:gpu` runs every hardware proof (`tests/browser/probes/`, `tests/browser/renders/`)
with the repository's own Playwright and esbuild, the machine's Chrome and its WebGPU device, and the
assets under `.mesure/assets/` ([TESTS.md](TESTS.md)). The material proof
(`tests/browser/renders/witness-materials.browser.ts`) renders twelve fixtures against the WebGL2
witness within one level per channel, except blending over an opaque surface, where the engine
blends in linear radiance and the witness in display space: the fixture declares that 45-level gap
and holds the engine inside it. The grazing fixtures are also cast on the CPU, the map's base level
averaged along each pixel's minified axis, on the tangent its derivatives lay, and cut once
(`tests/browser/support/groundTruth.ts`): a perfect anisotropic read, with no mip level and no
footprint cap. The proof counts both renderers' pixels over one level from it, silhouettes aside,
and requires the engine at 16× no farther than the witness, give or take CONTRIBUTING's tolerance:
0 px, 4 on the foliage cut-out (#443). A successful proof run is not a full-scene parity verdict, and
it measures no performance. The CPU shading oracle encodes linear lighting to sRGB without ACES; it
does not replace the displayed-image comparisons. Node tests validate orchestration with GPU doubles
and do not execute WGSL.

## Lighting: the target and the stages

The end goal of this engine, and the order it is reached in. The geometry, the temporal
antialiasing and the memory budgets are the foundation; this is what they are for. Each stage is
measured before the next is started, and a stage out of order is not out of scope.

Nothing here is copied from any engine: what follows comes from public material — SIGGRAPH talks
of 2021 and 2022, published documentation — and from what this engine already has.

End goal: the reference's lighting — dynamic global illumination, reflections, shadows — at its
performance, on the web.

What the reference is made of, and our counterpart:

| Reference piece                                   | Role                                                         | What we have today                                                                          | What is missing |
| ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------- |
| Temporal antialiasing                             | denoises everything stochastic                               | shipped, 0 px A/A                                                                           | —               |
| Screen traces                                     | first shot of every ray: image depth and normal, almost free | nothing                                                                                     | L1              |
| Distance fields (per mesh, then global)           | off-screen rays without hardware ray tracing                 | certified-error resident proxy, walked triangle by triangle                                 | L4              |
| Surface cache                                     | radiance of off-screen surfaces, updated under budget        | one radiance per triangle and proxy face, swept under budget                                | L4              |
| Screen probes (16 px grid) + world radiance cache | final gather, temporally filtered                            | cascaded SH2 world probes; no screen probe                                                  | L5              |
| Reflections                                       | screen traces, then distance fields reading the cache        | mirror-limit ray against the resident proxy, read in the surface cache (bounce on)          | L1, L6          |
| Virtual shadow maps                               | 16k shadow pages, only the views, cached                     | page table, screen-sized pool (2 601 pages at 720p), per-pixel level, receiver-marked pages | L3              |
| Stochastic direct lighting                        | few samples per pixel, denoised                              | tiled culling; four draws per moving pixel, exact at rest                                   | L2 (denoise)    |

What the web imposes, and the answer:

- **No hardware ray tracing**: the reference's software path — screen traces first, distance
  fields next — is the one taken; the distance field is baked by the compiler, like textures, at a
  resolution fixed by the budget.
- **Bounded, unreadable memory**: what streams enters a host-set byte reservoir, never read off
  the machine ([memory budgets](SDK.md#memory-budgets), adjustable in session), and displays coarser if it does not fit, never refused; image targets
  follow resolution with no ceiling.
- **One browser frame**: each piece has a millisecond budget and a reading by envelope difference;
  lot order follows what the measurement says costs, not preference.
- **No persistent threads, eight storage buffers per stage**: worked around as for the DAG cut
  and the compute raster.

Stages, each with its proof (0 px A/A at rest, budget held, before/after published):

- **L0** — done (campaign of 18 Sept. 2026, Emerald 2496×1404): the sun is 4.7 ms of
  envelope on the ground view and 5.8 ms on the street view (`mobile` − `sans-lumiere`); lighting
  without maps ≤ 0.96 ms (`lampes-4-sans-ombres` − `sans-lumiere`); still camera: 0 page redrawn,
  envelope no lower. What remained, the sampling, is L2 below — not a cascade ring.
- **L1** — screen traces: reflections and short bounce from the already-rendered HDR, depth and
  normal; the cheapest piece of the reference, and the first.
- **L2** — sampling done (#36, 20 Sept. 2026, Emerald 2496×1404, ground view, 32 shadowed
  lights reaching one pixel): a moving pixel weighs every light of its tile without its shadow,
  shades the four it draws — exactly those worth a sample's share, stratified for the rest —
  and the history averages the draws; a still image shades every light and converges to the
  exact sum, 0 px A/A. Envelope 39.9 → 17.9 ms GPU on a moving camera; the grain left in motion
  is declared in [Direct lighting](#direct-lighting). What remains of L2: a spatial denoise before the history,
  where the reference has one.
- **L3** — shadows in virtual pages from the hardware raster: only the pages seen,
  cached. The compute raster stays off; measurement kept it off.
- **L4** — baked global distance field, walked in compute, reading the proxy's surface cache.
- **L5** — screen probes gathering L1 and L4, filtered by temporal history; world probes
  for the far field; bounce on by default when its budget holds.
- **L6** — rough reflections and materials.

Exit criterion: on the same scene and the same machine as the reference, same image
to the eye, same byte budgets, same millisecond envelope.
