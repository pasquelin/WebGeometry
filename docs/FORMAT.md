# Cache formats 9 and 10 — produced and read by the SDK

This is the on-disk contract implemented today: what the compiler writes and the SDK reads.

## Layout

| Pointer                        | Payload                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native/<scope>/manifest.json` | `native/<scope>/<key>/clusters.json` and its pages, `source.gltf`, `source.bin`, SHA-addressed objects under `native/objects/`: `<digest>.bin`, one file per index page, geometry page or streaming bundle — and baked texture levels under `native/textures/v<N>/<digest>/<kind>-<level>.<format>`, one lossless PNG per mip level above the sidecar's tail, plus the same level in the cooked block family where the quality gate kept it |

`<scope>` is `slice` or `full`. A pointer or payload with another scope is rejected (`SCOPE_MISMATCH`).

Every served object carries the `.bin` extension and every object name is the SHA-256 of its content. A static file server needs no extension mapping, no MIME configuration and no rule of its own: `application/octet-stream` for `.bin` is what servers already do. The manifest names each object in full, so the extension carries no meaning the reader depends on.

## Pointer

```json
{
  "status": "ready",
  "formatVersion": 9,
  "compiler": "native-rust",
  "key": "<cache-key>",
  "scope": "slice",
  "url": "<key>/clusters.json"
}
```

`status` must be `ready`. `url` is resolved relative to the pointer. A cache containing `clustered-blend` uses `formatVersion: 10` in both this pointer and its metadata. Other caches are format 9. Formats below these are refused whole, by their number, before any field is read: format 5 added the [prepared-scene tables](#prepared-scene-tables), which a reader builds its scene from, and formats 7 and 8 write `selectedNodes` as a count where 5 and 6 wrote a list, so an earlier folder has no answer to give, and format 9 pages the manifest; the tables carry a version of their own, refused by name when it is not the one the reader builds from.

## `clusters.json`

`clusters.json` is the root of the manifest, of one size whatever the world (1 717 bytes at `full` scope for the grids of 48² and 192² and the open-world cell laid 8 × 8; `compiler_manifest_pages.rs`): the fields that name the product — `status`, `formatVersion`, `schema`, `scope`, `key`, `compilerVersion` —, `head`, the slot of the head page, and `pages`, eight slots of mesh pages, empty ones last, in the layout and through the pager of the [paged cell index](#world-partition). A page is `manifest-page-<sha256>.json`: the head, `{ version: 10, …, binary }`, holds every other field below and the descriptor of the texture previews' column file; a mesh page, `{ version: 10, primitives, binary }`, slim primitives and the descriptor of their columns; an index page, `{ version: 10, pages }`, at most eight slots. One mesh page lists every primitive today. A reader checks the root (`assertCacheRoot`) before it reads the pages side by side, each against its slot and each column file against its descriptor, and merges them (`readPagedManifest`). A compile that rewrites its key folder removes, once its new root is written, every manifest page and column file that root no longer names.

Required fields of the merged manifest, consumed by the browser adapter:

- `schema` / `formatVersion` — must agree: `10` when the cache contains `clustered-blend`, otherwise `9`
- `status` — `ready`
- `scope` — `slice` or `full`
- `selectedTriangles`, `selectedNodes` — how many triangles and nodes were kept: counts, not lists, so they do not grow with the number of placed objects
- `primitives[]` — `{ mesh, primitive, pass, clusterStrategy, pages, culling, structure, streams, dag, topology }`
  - `pass` is `exact-clusters` for opaque/MASK geometry, `clustered-blend` for static BLEND geometry, or `shared-blend` for unsplit source geometry (`KHR_materials_transmission` with `transmissionFactor > 0`, skins / `JOINTS_0` / `WEIGHTS_0`, and morph targets).
  - `clusterStrategy` is `dag-groups` on every primitive the DAG covers, and `null` on a `shared-blend` primitive, which carries no pages.
  - `errorModel` is `dag-group-qem-v2`, the one model this runtime reads: absolute group error weighing positions, normals and texture coordinates, clamped to the group's extent. A `dag-group-qem-v1` cache (positions only) is refused with `STALE_CACHE`. Every cluster carries its own screen-error band, so nothing walks a tree. A cache whose clusters carry no band — the page tree earlier compilers emitted — is rejected by `assertCacheIdentity` with `STALE_CACHE`, naming the primitive that lacks one, so a host recompiles instead of half-reading a cache.
  - `simplification` is `true` when the compiler ran with `qem-endpoints`.
- `binary` — `{ version, url, sha256, bytes, pageUrl, geometryUrl, bundleUrl, texturePreviews, texturePreviewBytes, texturePreviewBc7Bytes, texturePreviewAstcBytes }`, the descriptor of a page's [column file](#column-files).

Written for the compiler alone, ignored by the browser: `files` — `{ "<name>": { sha256, bytes } }`, one entry per other product of the key folder (`source.gltf`, `source.bin`, `proxy.bin`, `lights.json`, `scene-tables.json`, `scene.gltf`, `scene.bin`; the pages and cells of the [world partition](#world-partition) are proven through its root instead, and so are the manifest's pages, so the record does not grow with the world), which a later job of the same key checks before keeping the folder instead of rewriting it ([COMPILER.md](COMPILER.md#reusing-a-compiled-folder)).

### Column files

Per-cluster numbers are the bulk of a manifest: tens of thousands of clusters with a dozen values each. The compiler writes them as typed-array columns, one file per page (`manifest-page-<sha256>.bin`), and the page JSON keeps only what a human or a tool reads — primitives, materials, passes, reports, and the counts needed to find each primitive's slice of the columns. Emerald Square falls from 48.4 MB of JSON to 387 KB plus a 17.0 MB sidecar, and the reader maps the columns instead of tokenizing them.

The file is little-endian: `u32` magic `WGMB` (`0x424d4757`), `u32` version `10`, `u32` column count `29`, `u32` reserved, then one `(byteOffset, byteLength)` `u32` pair per column, then the payloads, each starting on an 8-byte boundary. Lengths and spheres stay `f64` — they decide a cut, so truncating them would change the image. A digest is stored as its 64 ASCII hexadecimal characters, and an object URL is rebuilt from the `pageUrl` / `geometryUrl` / `bundleUrl` templates by substituting `{sha}` — and a texture level from `textures.url` by substituting `{sha}`, `{kind}`, `{level}` and `{format}` —, which is why no URL is stored at all.

Indices inside a column stay local to the primitive: a group names the pages of its primitive, a page names the bundle of its primitive. Each primitive declares only its own counts in `primitives[].binary` — `pages`, and the `culling`, `structure` and `streams` counts — and the reader derives its base offsets by prefix sum, so the small JSON carries no offset to maintain. A reader refuses a missing magic, an unknown version, a different column count, a column out of bounds, a column whose length contradicts the declared counts, or a file whose size does not match `bytes`; it refuses the version before fetching the columns.

### Cluster DAG

Level 0 partitions the source triangles into clusters of at most 128 triangles, each covering its triangles exactly once and in a spatial order. Every level after that groups 8 to 32 neighbouring clusters, simplifies the merged group with the vertices it shares with another group locked, and re-splits the result into clusters of the same size. A runtime picks a cut: draw cluster `c` when `parentError > threshold >= lodError`, which covers the surface exactly once because coarsening is a group-wide swap.

`pages[]` entries carry, in addition to `{ id, url, sha256, bytes, count, min, max }`:

- `role` — `exact` at level 0, `coarse` above it
- `level` — DAG level, 0 for the source triangles
- `lodError` / `sphere` — object-space error of the group that produced this cluster, and the `[x, y, z, radius]` sphere it is projected through
- `parentError` / `parentSphere` — the same pair for the group that replaces this cluster; both `null` on a root, which is never replaced
- `group` — index in `structure.groups` of the group that replaces this cluster, `null` on a root
- `source` — index of the group that produced it, `null` at level 0
- `start` — offset of the earliest source index this cluster descends from, which restores a transparent draw order
- `stream` / `streamOffset` — streaming bundle holding this cluster and its byte offset inside it
- `geometry` — the optional independently decodable geometry page described under [Pages](#pages)
- `cone` — `{ axis: [x, y, z], angle }`, the normal cone of the cluster's triangles: the normalized sum of their non-degenerate face normals, each weighted by its triangle's area, and the half-angle, in radians, that holds them all; `{ axis: [0, 0, 1], angle: π }`, which rejects nothing, when no face is left or the normals cancel out. Every cluster has one. The axis has the bits the runtime's reference `triangleCone` gives for the same triangles, and the angle is never narrower than its angle, by at most a few ulps (`normal_cone.rs` says why); the WebGPU prepare reads no vertex for it. In a column file it is the `pageCone` column, four `f64` per page; sidecar version 9 added it, and a reader of version 8 refuses the file

`structure` — `{ version, roots, groups[] }`. `roots` lists the clusters nothing replaces. Each group is `{ level, error, sphere, children, outputs }`, where `children` and `outputs` cover the same surface and are never both drawn.

`culling` — `{ stride, count, nodes }`, a flat BVH over the primitive's clusters. `stride` is 15 numbers per node and node 0 is the root: `min[3]`, `max[3]`, `sphere[4]`, `maxParentError` (`-1` when the subtree holds a cluster with no replacement), `firstChild`, `childCount`, `firstPage`, `pageCount`. A leaf has `childCount` 0. Pages follow the culling order, so every node owns a contiguous page range.

`streams` — `{ version, pinned, bundleBytes, dependencyBound, maxDependencies, pages[] }`. A bundle is `{ url, sha256, bytes, count, dependencies }` and groups clusters of one level, targeting 128 KiB: the root clusters first, then the levels from the coarsest to the finest, each level ordered by the first bundle holding a parent of the cluster and then by culling rank, so siblings share a bundle. `dependencyBound` is fixed before packing: the most parents one cluster has. A bundle is closed early rather than hold clusters whose parents span more bundles than that, so no bundle needs more parent bundles than the primitive's neediest cluster has parents; a cluster that alone exceeds the bound is refused (`PAGE_DEPENDENCY_BOUND`, the page named). The bound holds each bundle's direct parent bundles only, not its closed list. `dependencies` lists, ascending, the bundles holding the parents of its clusters — the outputs of the group that replaces each of them — closed transitively up to the root cover. On WebGPU, a request for a bundle brings the missing bundles of its list, and the host keeps them retained with it; a cluster then enters the GPU pool only after its parents, whose bundles the list names ([ENGINE.md](ENGINE.md), residency). The WebGL2 page path does not read the lists yet. A pinned bundle lists nothing, every other one reaches a pinned bundle, and `maxDependencies` is the longest closed list: a statistic measured after packing, not a bound. In the column file a count per bundle (`bundleDependencyCount`) precedes the flat lists (`bundleDependency`); sidecar version 8 added them, and a reader of version 7, which cannot read them, refuses the file. The first `pinned` bundles hold exactly the root clusters, so keeping them resident guarantees a complete, if coarse, cover. Pinned bundles are then concatenated across primitives into shared objects of at most 1 MiB, so a first frame waits on a handful of requests instead of one per primitive; each entry names the shared object and every cluster keeps its own `streamOffset` inside it, unchanged for the reader. A cluster stays individually addressable through its own `url` and through `streamOffset` inside its bundle.

`dag` — a report, not a contract: `{ depth, clusterTriangles, groupMin, groupMax, levels[], groups[], warnings[], stalls[], rootTriangles, cause, seamVertices, lockedVertices, uvIslands }`, where `groups[]` tallies per level why a group reduced or did not (`reduced`, `tooSmall`, `seamLocked`, `borderLocked`, `unreducible`, `borderLost`, `unusableError`; the causes are defined in [COMPILER.md](COMPILER.md), _The corpus_) and how many reductions needed a retry (`relocked`: extra locks to keep the border or a face lit from its side). `levels[]` gives per level `{ level, clusters, triangles, roots, rootTriangles, errorMin, errorMedian, errorMax, normalDeviationMax }`, `rootTriangles` the triangles of the level's roots — their sum is the root cover, what the smallest budget still draws — and `normalDeviationMax` the largest angle, in degrees, between a face and the normal its centre is shaded with ([COMPILER.md](COMPILER.md), _Invocation_). `stalls[]` lists every stalled group as `{ level, cause, triangles, seamVertices, lockedVertices, uvIslands }`: the level it was built for, its cause (`too-small`, `seam-locked`, `border-locked`, `unreducible`, `border-lost`, `unusable-error`), its live triangles, its positions written under several texture coordinates, those it shares with another group of the level, and its connected texture islands. `rootTriangles` counts the level-0 triangles no coarser level replaces, `levels[0].rootTriangles`; `cause` is the cause of the stalled groups holding the most triangles (`null` without a stall); `seamVertices`, `lockedVertices` and `uvIslands` are summed over the stalled groups. Wall-clock times are not in the cache, which a rebuild reproduces byte for byte: the primitive's stage timings travel on its `primitive` progress event ([COMPILER.md](COMPILER.md), _Events_). `warnings[]` names a DAG that did not climb — `DAG_FLAT` (several clusters, no coarse level) or `DAG_ROOTS` (more than one root per eight pages on a primitive of eight clusters or more) — with `roots`, `pages`, the `groups` tally summed over every level, and `rootTriangles`, `cause`, `seamVertices`, `lockedVertices`, `uvIslands` as above; the compiler also carries it on the primitive's progress event, and the engine reports it as the `dag-warnings` diagnostic when the cache is opened, with the stall summary of every primitive holding a stalled group (`stalled[]`), warned about or not.

Static BLEND geometry joins the DAG on the same terms as opaque geometry but keeps its transparent forward pass, original material flags, vertex attributes and source mesh sorting; `start` restores the source draw order that spatial clustering would otherwise scramble. Simplification changes indices only: it keeps existing vertices and locks every vertex shared with another group, so group borders stay watertight. A group that cannot be reduced keeps its children. The positional error does not bound texture-alpha or compositing error: `pixelError=0` is the exact-geometry comparison, and nonzero error settings require a visual check. Transmission remains unsplit because its refraction semantics are separate from alpha blending.

The reader accepts cache formats 9 and 10 and rejects every other version. Format 10 is required for `clustered-blend`, so an older reader rejects it instead of treating transparent pages as opaque; every other cache is format 9 (`FORMAT_VERSION`, `CLUSTERED_BLEND_FORMAT_VERSION`). SDK, compiler and cache versions are independent; the compiler fingerprint additionally changes the cache key.

The compiler validates selected accessors against their own `bufferView` length, including stride and sparse index/value ranges, before publishing a ready pointer. Sparse indices must be strictly increasing and within the accessor count. The Rust fingerprint includes its source modules, `Cargo.toml` and `Cargo.lock` at build time. Source JSON, declared sidecars, geometry bytes, compilation options and the error-model identity also participate in the cache key. Changes create a new key and leave source assets untouched. External image bytes referred to by URI are not embedded in the manifest or included in this geometry key — their SHA-256 is, and the baked levels under `native/textures/` are addressed by it; hosts own their resource identity.

## Pages

Each page is a tightly packed little-endian `u32` index buffer covering at most 128 triangles (384 indices) of one DAG cluster. The runtime verifies SHA-256 and byte length before attaching a page. A streaming bundle is the concatenation of those index buffers for the clusters it holds, in the order their `streamOffset` values give.

Static opaque, alpha-mask and clustered BLEND primitives can additionally carry `pages[].geometry`: an independently decodable quantized cluster page with URL, SHA-256, byte length, vertex/index counts, attribute flags and decoded-byte estimate (`uncompressedBytes`: the page once unpacked to float attributes and 32-bit indices, what a reader that expands the page holds; `bytes` is what a reader that decodes in place keeps resident). The manifest declares the page format once, at its top: `geometryPages: { formatVersion: 3, codec: "quantized" }`. This geometry-page version is independent of the outer cache version: the optional fields and `autonomousScene` are additive, while `clustered-blend` requires outer cache format 10. A reader of a cache whose `geometryPages` is missing or of another format refuses it whole, as it refuses a sidecar of another version than 10 — the sidecar names only this page — and every page header opens with the same version. The index pages remain available for existing backends.

#### Quantized cluster page (`WGP3`)

The page is the published cluster format — positions on an object grid, octahedral normals, integer texture coordinates, colours on a grid, bit-packed local indices, no tangent — rebuilt from the literature for the web: twenty-four little-endian `u32` header words, then bit streams that start on a word each, and nothing else. A field never spans more than two words, so a shader reads any vertex or corner of a resident page in place, in O(1), without unpacking it (`packages/sdk-browser/src/cluster/decodeWgsl.ts`); the JavaScript and WebAssembly decoders unpack the same bytes to floats for the autonomous backend.

| Word  | Content                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------- |
| 0, 1  | magic `WGP3` (`0x33504757`), version `3`                                                                        |
| 2, 3  | vertex count (1 to 65,535), index count (a positive multiple of 3)                                              |
| 4     | attribute flags: `1` NORMAL, `2` TEXCOORD_0, `4` TEXCOORD_1, `8` COLOR_0                                        |
| 5–8   | position record and minimum: one `f32` per axis                                                                 |
| 9–11  | TEXCOORD_0 record and minimum                                                                                   |
| 12–14 | TEXCOORD_1 record and minimum                                                                                   |
| 15–19 | COLOR_0 record and minimum, four channels                                                                       |
| 20    | `f32` quantization error: the largest distance between a source position and its decoded value, in object units |
| 21–23 | reserved, zero                                                                                                  |

A record word holds the width of each component in six-bit fields from bit 0 (each 0 to 24) and the grid exponent as a signed byte in the top byte; a component of zero width is constant and has no stream. Streams follow in this order — indices, position `x`, `y`, `z`, normal (if flagged), `u`, `v` of TEXCOORD_0 (if flagged), `u`, `v` of TEXCOORD_1 (if flagged), `r`, `g`, `b`, `a` (if flagged) —, each `ceil(count × bits / 32)` words, each field `i` at bit `i × bits`, least significant bit first. Index fields are `ceil(log2(vertexCount))` bits wide; a normal is 16 bits. Every offset follows from the counts and the widths, so the header stores none and a reader trusts none: the byte length must equal what the streams need, a header field outside the format (a width above 24, an exponent beyond ±64, a non-finite minimum, an unknown flag, a negative error, a reserved word set) refuses the page before any stream is read, and an index at or past the vertex count refuses it before any float is produced.

Decoding is one multiply and one add per component, on 32-bit floats: `value = min + q × 2^exponent`, the product exact because the step is a power of two, the sum rounded once — so the three decoders (`geometryPage.ts` through `Math.fround`, the Rust codec, the WGSL routines) produce the same 32-bit float, which `tests/browser/probes/cluster-decoding-gpu.ts` proves on the graphics card bit for bit. A normal is two bytes, `x` low and `y` high, `(q × 2/255 − 1)` per byte, the lower hemisphere folded (`z < 0`) then normalized; the constant is `2/255` rounded to the nearest `f32` by each language. The sign of zero is not kept: `-0` lands on the cell of `0`.

The compiler chooses the position grid per primitive, the finer of two rules: `exponent = floor(log2(widest extent)) − 16`, so a primitive spans about 2^16 steps, and `floor(log2(finest group error / 8))`, so a cluster's displacement projects below an eighth of the threshold wherever the cut selects it (the finest group error is the smallest non-zero `lodError` the DAG published). The error rule is bounded below by `floor(log2(widest extent)) − 22`, so the primitive never spans more than 2^23 steps and every page fits the 24-bit field on the primitive's own exponent: every page of a primitive shares that exponent, which is what makes a vertex shared by two clusters land on the same cell in both. Each cluster then spends only the bits its own box needs; a page that would still need more than 24 bits on its primitive grid — a texture coordinate range past 1024, a colour range past 65,536 — is refused whole (`PAGE_ATTRIBUTE_RANGE`), never re-gridded on its own. Texture coordinates sit on a grid of `2^-14` — a quarter of a texel on a 4096-wide map; the compiler never leaves it, and the engine's runtime cutter takes the finest coarser grid only for a primitive whose widest cluster spans past 1024, such as a long dashed line's distance along it, the record word carrying the exponent every decoder reads — and colours, clamped to `[0, 1]`, on `2^-8`, with the same per-page minima and widths: a constant channel costs no bits. The cost is declared, never hidden: word 20 carries the page's worst position displacement, rounded up to the `f32` so that no position exceeds it — every decoder returns it, and the autonomous backend widens a page's box by exactly that —, and `primitives[].quantization` — `{ positionExponent, uvExponent, maxPositionError }`, the step being `2^positionExponent` — carries the primitive's for reporting, `null` on a primitive without pages, which was quantized on no grid. The cut adds it to a cluster's error: a cluster **a group produced** is certified at `lodError + maxPositionError`, a group at `error + maxPositionError`, and every cluster box and culling-node box grows by the same length, so the pixel threshold bounds the quantized surface an engine actually draws rather than the source one it was measured on (spec C4; the colour and texture-coordinate terms of that line remain open). **A cluster no group produced keeps its band**: it is the floor of the ladder, the cache holds nothing finer, and raising it would leave the cut with nothing to draw at zero pixels — its boxes grow all the same, since they bound the surface drawn. Both sides of a replacement therefore swap at the same threshold and the cut stays a partition. A normal is within 1° of its source, a colour within half a level of 256.

Two source vertices that land on the same cells decode alike, so the page keeps one and remaps its corners: a source that repeats a vertex per corner — Whisperwind's FBX import carries 2.6 vertices per triangle — comes down to its distinct vertices without changing a triangle. Tangents are never written: every lighting pass rebuilds one cotangent frame from a triangle's normal, two edges and the texture deltas along them (`cotangentFrame`, in WGSL beside the decode routines and in GLSL for the WebGL2 renderer; a raster passes the triangle's edges, a fragment stage its screen derivatives), as the reference does. A texture coordinate set that no texture of the primitive's material names in `texCoord` is not written either — residency follows what the frame reads —, while the DAG still welds along it, so clusters do not depend on what a material samples.

When every selected primitive has autonomous pages, the compiler also publishes `scene.gltf` and `scene.bin`. This light glTF retains node transforms, material declarations and images but replaces geometry accessors with a dummy triangle; the browser's `autonomousGeometry: true` backend builds real meshes only from verified geometry pages. It does not request the complete `source.bin` geometry. The runtime reads its images from where the [prepared-scene tables](#prepared-scene-tables) locate them, as for `source.gltf`: this backend samples `texture.image` and reads no baked level. Skipping an image — replacing it by a one-pixel placeholder at preparation time and reading its levels from the cache on demand — belongs to a session whose every mounted backend reads those levels, the WebGPU page raster, and the engine resolves `textureSource` against what it chose to draw with (`resolveTextureSource`), so no machine loses its textures. Transparent autonomous pages are not implemented. The initial complete root cover is loaded before the explorer becomes ready. `maxResidentPages` counts displayed page instances, while the streamer deduplicates URL transfers; neither limit measures physical VRAM or total application memory.

## Textures

The compiler bakes the **whole mip chain** of every texture an atlas reads — base colour and emissive for the colour atlas, metal-roughness, normal and occlusion for the data atlas — and the engine reads those levels wherever the cache carries them, whatever the host asked of its loader: it regenerates a chain only for a texture the cache has none for. The chain is split in two:

- The **tail**, from the first level no side of which exceeds `PREVIEW_BASE` (64 px) down to 1×1, lives in the head page's column file and is on the card before the first frame: raw RGBA8 in `texturePreviewPixels`, and, for each block family the quality gate kept the chain in, the same levels block-compressed in `texturePreviewBc7` (the BC family) or `texturePreviewAstc` (ASTC 4×4), one byte per texel, no offset written — each kept entry's range follows the previous one's at the length its dimensions imply. One entry per `(texture, atlas)` pair, fourteen `u32` in `texturePreviewU32`: `texture`, `image`, `width`, `height`, source kind and buffer view, first level, level count, pixel offset and byte length, `atlas` (0 colour, 1 data, 2 colour weighted by coverage, whose cutoff byte `C` fills bits 8–15, 0 when a reader blends), `bakedLevels`, then the **layout word** of each family — `0` lossless (no blocks in that family), `1` RGBA blocks, `2` two-channel blocks. Entries are strictly increasing by `(texture, atlas)`, a coverage chain counting as its texture's colour-atlas entry — one texture carries a plain or a coverage colour chain, never both —, and a reader recomputes every level's geometry from `width`/`height` instead of trusting the entry; a block column that ends before or after the last kept entry, a layout word no layout owns, or blocks under a lossless word, refuse the sidecar whole.
- The **head**, levels `0` to `bakedLevels - 1`, is one file per level and per kept format at the template `clusters.json` publishes in `textures.url` (`../../textures/v<N>/{sha}/{kind}-{level}.{format}`, relative to `clusters.json`): `{sha}` is the SHA-256 of the source image bytes, `{kind}` is `srgb`, `linear`, `srgb-coverage` or `srgb-coverage-<C>`, `{level}` the mip rank, `{format}` `png` (lossless, always there), `bc7` / `bc5` (the BC family, RGBA and two-channel layouts) or `astc` / `astc-la` (ASTC 4×4, the same two layouts) — a level's blocks row-major, a side that is not a multiple of four padded by its edge. Levels are content-addressed, shared by every scene that shares the image, never rewritten once present, and pruned like objects when no surviving manifest names their digest. `v<N>` is `TEXTURE_PREVIEW_VERSION`: a change of the reduction rule, of a codec or of the gate's bar changes the path, so stale levels are never served.

**Block layouts and the quality gate.** A cook writes one block family (`--textures-format=bc7|astc|both|none`, `bc7` by default: a cook runs on a desktop). A texture's layout follows its role: **RGBA** — BC7 mode 6 (one subset, 7-bit RGBA endpoints with a shared low bit, 4-bit weights) or ASTC single-partition colour endpoint mode 12 at the 192-level range with 3-bit weights — for base colour, emissive, metal-roughness and occlusion maps; **two channels** — BC5 (two BC4 channels, eight rungs each) or ASTC luminance-alpha (colour endpoint mode 4, dual plane, quint weights) — for a texture only `normalTexture` reads, X in the first channel, Y in the second (BC5) or in alpha (ASTC), Z rebuilt by the shader as `sqrt(1 − x² − y²)`. Every chain is then read back through an independent decoder (`texture2ddecoder`) and compared with its RGBA8 levels on the channels the materials read — an opaque base colour's alpha is not read, a normal map's three are, Z rebuilt against Z stored — and it is **kept only if** its PSNR over the whole chain reaches **48 dB**, no texel moves by more than **3 levels** of 255 on a read channel — the definition of "no visible loss" for a block texture: on a still capture at 1280×720, DPR 1, every channel of every pixel within 3 of 255, below what an 8-bit display discriminates, and 0 px of A/A; the bound is carried to the texel, since filtering only averages texels, and measured on the captures of the batch —, and no texel of a masked texture changes side of its alpha cutoff, its alpha times the material's colour factor alpha against the cutoff, as the engine cuts it. A chain under the bar stays lossless in that family: no block file, no block tail, the layout word says so, and the engine samples it from an RGBA8 pool. The compile report (`clusters.json`, `texturePreviews`) publishes the bar (`qualityGate`), the counts per family and layout (`encoded`), the kept chains' PSNR quantiles, and every chain left lossless with its PSNR, largest gap and flips (`lossless`). The codecs are the compiler's own, pure Rust, one layout each and no mode search; their blocks are proved on the same independent decoder.

Every level, tail and head, follows the rule the card applied when it regenerated the chain itself (`packages/sdk-browser/src/texture/mips.ts`): level `k` from the **quantized** level `k - 1`, colours averaged in the atlas's own encoding (sRGB decoded and re-encoded for the colour atlas, linear for the data atlas), alpha the **median** of the four texels, an odd side repeating its last texel. The colours are a plain mean, except for a colour texture **every** reader of which takes its alpha for coverage — the base colour of `BLEND` materials that do not transmit, or of `MASK` ones whose cutoff is above 0, only —: that texture has its own chain, `atlas` word `2` and `{kind}` `srgb-coverage`, where four texels whose alphas differ average their linear colours weighted by alpha (premultiplied, averaged, divided by the summed alpha, stored straight), so the colour under a transparent texel no longer darkens a cutout's border (#42); when every reader cuts, the median alpha of every level is then scaled so that it covers the share of texels level 0 covers (#44, below); an image whose alpha never varies keeps the plain chain, which weighting would not change by a byte. One opaque or transmissive base colour or one emissive among the readers, and the texture keeps the plain chain byte for byte, since that reader draws the colour under alpha 0; the data atlas never weighs. Its files, named apart, are never shared with the plain chain of the same image in another scene, and the card regenerating a hosted texture takes the same decision from the same material census. The file's declared transfer does not enter the rule: the pyramid follows the display, not the file. Baking instead of regenerating therefore keeps the image within rounding — measured on Emerald at 2496×1404: 0 pixels beyond ±2 per channel on the general view, and on the lawn view 1 720 isolated pixels (0,05 %) where the median alpha of a coarse texel lands on the other side of the 0,5 cutoff, plus their shadows when the sun is on. Remeasured when the engine stopped regenerating what the cache carries (#289), at 1280×720, DPR 1, threshold 0, TAA off, lossless pools on both sides: the four Emerald views differ by at most 2 of 255 on a channel — one channel of one frame at 3 — with a mean absolute channel error of 0,009 to 0,049 of 255, Whisperwind by 5 pixels at 1 of 255, against an A/A witness of 0 px on every view. The same rule written twice, once on the card and once on the processor, is a rounding apart and no more.

**Coverage-preserving alpha (#44).** The median alone thins a masked texture out at the coarse levels — sponza's masked maps held their coverage within ±2.4 % down to 32² texels, then lost 3 to 15 % at level 6, up to 40 % at level 7 and 57 % at level 8. A coverage chain therefore carries the cutoff byte `C` of its texture: the lowest cutoff among the materials that read the texture's alpha as coverage, each material's the smallest byte `b` with `b / 255 × f >= alphaCutoff` in `f32`, `f` its `baseColorFactor` alpha — the product itself, since the cutoff divided by `f` lands a byte off on exact ties; glTF 2.0 cuts the sampled alpha times the factor's against `alphaCutoff`, and both backends do (`maskKeep`, #748; WebGL2's `baseFactor`, #769) —; a factor of 0 or below, or a cutoff at or above the factor, keeps at most the fully opaque texels and takes `C = 255`, which the lowest over the readers ignores beside any other cutoff; or 0, and the median alone, when one of them blends — a blended surface draws the alpha itself, and the scale would move its mean. Two textures of one image cut at two cutoffs, or one of them blended, bake one chain each. Coverage is counted on the bilinearly filtered cut, as the sampler draws it, not on the texels (Castaño's practice, #43): four samples per texel, at the quarter points of the square between its centre and those of its right, lower and diagonal neighbours — an edge texel its own neighbour —, each the byte `(9a + 3b + 3c + d) / 16` of the square's corners rounded half up, `a` the nearest: a filtered alpha passes the cut from `C − 0.5` — exactly the engine's cut at `alphaTest` 0.5 —, where the scale puts `t − 0.5`. Then, at each level `k >= 1`, after the median: with `n0` the samples of level 0 `>= C`, `N0` and `Nk` the texel counts of levels 0 and `k` (four samples a texel on both sides), and `above(t)` the samples of level `k` that the scale at `t` lifts to `C` or more — each sample filed in a 256-bin histogram under the highest such `t`, 0 when none, found by a binary search between the square's lowest and highest corners, since the scale only grows as `t` falls, a corner reaches `C` exactly when `t` is at most its byte and a sample lies between its corners —, `t` is the byte of `1..=255` minimising `|above(t) × N0 − n0 × Nk|` — ties to the `t` nearest `C`, then to the lower —, and every alpha `a` of the level becomes `min(255, (2a(2C − 1) + 2t − 1) / (4t − 2))` in integers, the division truncating: `a × (C − 0.5) / (t − 0.5)` rounded half up, so exactly `above(t)` filtered samples of the stored level reach `C`. Every level is matched against level 0, never against the previous one; `t = C` leaves a level byte for byte; level `k + 1` is reduced from the scaled bytes; colours are not touched. This compiler (`texture_preview/coverage.rs`) applies this rule and this arithmetic, and so do the chains the card builds for a hosted texture, from the same arithmetic in WGSL and GLSL (`texture/coverageRule.ts`): WebGPU counts each level and picks its `t` in a compute pass (#748, `texture/coverageMips.ts`), WebGL2 counts by additive blending into an RGBA float target, one channel per sample, and picks `t` in a one-texel draw (#769, `webgl/cluster/coverageMips.ts`) — a context without `EXT_color_buffer_float` and `EXT_float_blend` keeps the median alone —, once per chain built — a live texture builds one per new picture —, never per frame otherwise; the filtered cut costs the counts four samples a texel and a search of at most eight steps each, the frame nothing. Its files are `srgb-coverage-<C>`, one name per cutoff, so two scenes cutting one image at two cutoffs never serve each other's levels; the blended-only chain keeps `srgb-coverage` and its bytes. Counting on the filtered cut (#43) moves the bytes of the `srgb-coverage-<C>` chains under their names, and level files are written only when missing: `TEXTURE_PREVIEW_VERSION` 5, whose folder `textures/v5` serves no level of the texel-count rule.

An image whose decode fails has no entry: its textures load from the source as before. A texture whose chain is not whole (`bakedLevels < firstLevel`) also keeps the source path, in the engine's lossless lane, whatever the family the device samples.

## Prepared scene tables

`scene-tables.json`, beside `clusters.json`, says what the prepared scene is made of, and it is the
only thing the runtime builds that scene from: no glTF is parsed in the browser. Its own version
governs it — `version` 4, `nodeTableVersion` 3, `materialTableVersion` 4, `geometryTableVersion` 1 —
and an unknown one is refused rather than half-read (`assertSceneTables`, `UNSUPPORTED_SCENE_TABLES`).
Every value is read from the `source.gltf` the same compilation publishes (and, for its layout, from
`scene.gltf` when one is written): the slice's nodes, the cutout answers already applied, the mesh
ranks already remapped.

- `scene` — `{ name, nodes }`: the scene the document opens (`scene`, else the first) and its roots.
- `nodes[]` — every node the partition's cells do not place, in glTF order, renumbered without
  them (every node, at its glTF rank, when `partition` is `null`): `{ name, children, mesh, light, camera, weights,
matrix, translation, rotation, scale }` (`weights` overrides its mesh's morph weights). The pose is the LOCAL one exactly as declared, each part `null` when silent:
  the runtime composes world matrices from it the way it always has, so they are the same bits.
  Several nodes naming one mesh is what instancing is here.
- `partition` — `null`, or the world partition (below): the cells that place the other nodes.
- `lights[]` — the `KHR_lights_punctual` lights the nodes hang: `{ name, type, color, intensity,
range, innerConeAngle, outerConeAngle }`, each silent field `null` (the specification's default
  applies). `lights.json` stays the radiometric product the engine lights with.
- `cameras[]` — the cameras the nodes carry: `{ name, type, yfov, aspectRatio, xmag, ymag, znear,
zfar }`, each silent field `null`.
- `materials[]` — the surface fields the engine reads: `lit`, `baseColor`, `metalness`,
  `roughness`, `doubleSided`, `backSide`, `alphaTest`, the six map slots (`map`, `metalnessMap`,
  `roughnessMap`, `normalMap`, `aoMap`, `emissiveMap`), `normalScale`, `normalScaleY`,
  `aoIntensity`, `emissive` (the factor times `KHR_materials_emissive_strength`), `transmission`,
  `ior`, `thickness`, `attenuationDistance`, `attenuationColor`; and what the host surface is built
  as: `kind` (`unlit`, `standard`, or `physical` when a physical extension is declared),
  `alphaMode` (`OPAQUE`, `MASK`, `BLEND`), `opacity` (the fourth number of the colour factor), and
  `extensions` — what clear coat, sheen, iridescence, anisotropy, dispersion, specular, bump and
  the transmission and thickness maps add, under the host's parameter names with its defaults.
  One glTF material is one entry **per tangent variant**: a host that rebuilds the tangent frame
  from screen derivatives flips `normalScaleY`, so a primitive names a rank in this table, not the
  glTF material rank, and `derivativeTangents` says which variant the entry was written for. A
  primitive that declares no material wears an entry holding the glTF default one.
- `textures[]` — at the glTF texture rank: `{ name, sampler, image, wrapS, wrapT, magFilter,
minFilter }`, `image` the source an `EXT_texture_webp` then `EXT_texture_avif` names before the
  core `source`, as the loader reads it; in the engine's words (`clamp`/`repeat`/`mirror`, `linear-mip-linear`…), with the
  specification's defaults where the sampler is silent; `sampler` is the glTF sampler rank, which
  together with the image's source decides which textures are one. A map slot is
  `{ texture, texCoord, slotTexCoord, transform }`: `texCoord` the set sampled — the
  `KHR_texture_transform`'s when it names one —, `slotTexCoord` the set the slot names itself,
  which decides whether the host reads the glTF texture or a copy of it and so which rank the slot
  keeps, and the transform the `KHR_texture_transform` it declares — `{ offset, rotation, scale }`,
  each `null` when silent — or `null`; the host composes the matrix.
- `documents` — the geometry layout of each published document, keyed by its file name
  (`source.gltf`, and `scene.gltf` when written): `{ buffer, views, accessors, meshes, images }`.
  `buffer` names the one binary the document is published with; a view is `{ offset, length,
stride }` into it; an accessor `{ view, offset, componentType, normalized, count, type, min, max,
sparse }`, `sparse` being `{ count, indices: { view, offset, componentType }, values: { view,
offset } }` or `null`; a mesh `{ name, weights, primitives }`, each primitive `{ attributes,
targets, indices, material }` — accessor ranks by glTF semantic, its morph targets (each a set of
  accessor ranks, `null` for none), and the rank of the surface it wears in `materials[]`, for that
  document's own tangent variant; an image
  `{ name, uri, view, mimeType }`, an address relative to the document or a view of its binary.

### World partition

A node that only places a mesh — a leaf the scene reaches, carrying no light, no camera, no skin
and no morph weights, that no animation moves, whose mesh declares its position bounds and does
not morph — is a **placement**. When the placements of a scene weigh more than one stream unit
(`STREAM_BUNDLE_BYTES`, 128 KiB, the budget of a geometry bundle), the compiler moves them out of
`nodes[]` into spatial cells (`packages/asset-compiler-rust/src/compiler_tables/partition.rs`), and
the runtime reads the cells by distance to its camera instead of reading every node before its
first frame. A scene whose placements fit one unit keeps them in `nodes[]` and has `partition:
null`: its tables are the ones it always had.

The placements are halved along the widest spread of their centres until a cell's placements fit
the unit. Each cell has a **record** `{ url, sha256, bytes, parents, meshes }` — its file beside the
tables (`scene-cell-<n>.json`), fingerprint and size (the reader verifies them as it verifies a
page), `parents`, `[[rank, box], …]`: for each core node its placements hang under (`null`, the
scene), the box around them **in that node's frame**, and `meshes`, `[[rank, count], …]` in rank
order: how many placements of each mesh it holds, which the runtime sizes its rows by before
reading any cell. A cell file is `{ version: 2, nodes }`, each node `{ parent, mesh, matrix, translation,
rotation, scale }`: `parent` the rank in `nodes[]` of the core node it hangs under (`null`, the
scene), its mesh, and its local pose exactly as declared, each part `null` when silent. A
placement's name is not kept: it is a row, not a host node.

**The paged cell index** (`partition/pages.rs`, #750). The records lie in pages cut from the
halving tree, each node a contiguous range of cells: a region page `{ version: 2, cells }` holds the
records of the highest node under 128 KiB (`PAGE_BYTES`; one cell whatever its size), an index page
`{ version: 2, pages }` lists at most 8 pages (`FAN_OUT`), its node opened largest first, and
`partition` is the root `{ version: 2, pages }`: the whole tree opened into exactly eight slots,
empty ones last — 1 391 bytes for grids of 48² and 192² and the open-world cell laid 8 × 8. A slot
is 168 hexadecimal digits: the page's SHA-256, its size (8) and its box at the declared poses as six
big-endian `f64` bit patterns (16 each), naming `scene-page-<sha256>.json`; zeros name no page.
`readTablePartition` reads every page through its caller's `read`, which verifies it against its
slot (`fetchVerified`), into the records in cell order, `bounds` the union of the root's boxes and
`meshes` the ranks placed. Pages and cells are outside
the manifest's `files`: a reused folder proves them through the root.

**Reading the cells.** Each mesh the cells place is drawn by one host mesh per primitive whose
instance buffer the cells fill (`packages/sdk-browser/src/scene/partition/`): a placement takes a
row at the world matrix the engine composes for a child of its parent — the same bits a host node
there would carry, proven against the host loader on `site/assets/examples/ten-thousand-objects`
(`host/prepared/partition.test.ts`) — and gives it back, parked, when its cell leaves. A page may
move a core parent (`getObjectByName`): the rows under it are rewritten, and the cell's boxes are
its parents' boxes under their current matrices (`boxes.ts`), so the cell is read where its
placements stand, at the distance of its nearest box. A cell is read while the camera can draw any of it: its **reach** is the far plane met on the frustum's
diagonal, `far·√w`, with `w = 1 + (tan(fov/2)/zoom)²·(1 + aspect²)` the off-axis stretch of the frustum.
The error target does not shorten it: nothing coarser stands for a cell that is not read (the
proxy of #23), so an object dropped below the target would be missing from the image, not
replaced. An orthographic camera reads up to the far corner of its zoomed box. Before its first frame a session reads the cells within
the reach of the camera the page draws with (a world hands its camera to the session it opens; a
bare explorer, which has none, reads for its framing camera, which sees the whole scene), and
nothing else. Then, before every frame, cells within the reach are
asked for nearest first, those within `1.25 × reach` at the prefetch priority, and a read cell
leaves once its box is past `1.5 × reach` (`AHEAD` and `KEEP` in `plan.ts`): margins of the reach,
never of the cell, so a cell cut wider than the view is kept only while its box meets that sphere. The cells are read through the session's page streamer
— one request queue — and placed within the frame's one integration budget, the session's
(`ARRIVAL_BUDGET_MS`, `FrameBudget`): its clock starts once per frame, the cells spend from it
first, the page arrivals drain from what is left, then the WebGPU row records; the first
integration of a frame always goes through.
The rows are sized once, when a session opens and before its engines read them, for every
placement its camera's reach can hold at once **wherever the page moves the core parents**
(`sizing.ts`). A held cell has a box within `1.5 × reach` of the eye; the boxes one parent carries
move together, so those held at once are close in that parent's own frame — centres within
`(2 × 1.5 × reach + √3 · most · (r₁ + r₂)) / least`, `r` the radius around a box and `least`,
`most` how far the parent stretches the root's frame (the root's own boxes: a gap within
`2 × 1.5 × reach`). The largest sum of `meshes` over the cells that close to any one box of a
parent, summed over the parents and never past every placement, bounds each mesh's rows — set by
the reach, the cells' size and the parents' count, not by the world or where its parents stand.
Parents moved together never run the rows short, so they never reopen the session nor leave a
placement undrawn (CONTRIBUTING.md §Streaming rule 10). A camera whose reach later outgrows the
rows, or a parent scaled down or stretched more unevenly than at opening (moved, turned or scaled
up, it holds), grows them in place, to twice what is asked, on an engine that follows the growth
contract (`placement/growth.ts`); on one that does not, it asks the session's owner, once, to
open it again sized for them (the world does). A session no owner
can open again (a bare explorer) sizes its rows for every placement, and rows that hold every
placement never ask. A session drawing on demand draws again, camera still, until the cells it
asked for within reach are read and placed. A partitioned scene is not
replicated (`UNSUPPORTED_SCENE_UPDATE`).

The merged, simplified proxy of a far cell (HLOD) is not part of this format: #23 carries it.

The runtime builds its host scene from these alone (`packages/sdk-browser/src/host/prepared/`):
attributes viewed on the binary, the local box the positions declare, textures folded on image
source and sampler, surfaces and their vertex-colour and flat-shading variants, nodes, meshes and
cameras and lights assembled and named as the host loader assembled and named them — proven equal to the
loader's graph, field by field and byte by byte, on every cache `site/assets` publishes
(`packages/sdk-browser/src/host/prepared/build.test.ts`). A layout that names a document the tables
do not carry, a view outside its binary, or a cell placing a mesh the scene built no rows for,
is `PREPARED_SCENE_MISMATCH`.

## `physics.json` — cooked colliders

Written beside `clusters.json` by the compiler's `physics-cook` stage ([COMPILER.md](COMPILER.md)),
with a `formatVersion` of its own (2): a reader refuses any other (`PHYSICS_FORMAT`, recompile the
model). Format 1 carried the declared bodies in another shape, and no matter on an instance. The shapes it
names are Jolt's binary state (`Shape::SaveWithChildren`), readable only by the Jolt that wrote them:
the file names that commit in `jolt`, and the engine refuses a file cooked by another. `stage` names
the stage and its version.

| Field       | Content                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `colliders` | One per compiled primitive with a DAG: `primitive`, `material` (glTF index), `kind` (`mesh` or `heightField`), `tolerance` (the object's DAG error the level holds), `hausdorff` (measured to level 0, at or under `tolerance`), `triangles`, `tiles`                                                                                                   |
| `tiles`     | One Jolt shape each, a SHA-addressed object like a page: `url`, `sha256`, `bytes`, `triangles`, `bounds` (min and max in the primitive's frame). Every triangle of a tile is of its collider's `material`: an exact hit reports that one. A tile of small triangles is a `MeshShape` cooked a power of two larger inside a `ScaledShape` of the inverse |
| `instances` | Static placements: `node`, `collider`, `position`, `rotation` (x, y, z, w), `scale`, and the `friction` and `restitution` of the `physicsMaterial` the node's `KHR_physics_rigid_bodies` collider names, if any. A node whose matrix shears cannot be a body pose: it is counted in `report.unplaced`                                                   |
| `report`    | Counts, the largest tolerance and the largest measured distance, and `refused`: each primitive whose collider Jolt refused (`primitive`, `mesh`, `meshPrimitive`, `reason`, Jolt's error). Such a primitive has no collider and is drawn all the same: a refusal never fails the compile                                                                |

The manifest's `physics` field names the file, its format, the Jolt commit, the report and every
object the file cites (`objects[].sha256`), so a prune keeps them.

### `bodies` — declared rigid bodies

Stage version 6 adds `bodies`, one entry per node of the rendered scene whose
`KHR_physics_rigid_bodies` declares a `motion` ([COMPILER.md](COMPILER.md#physicsjson--the-cooked-colliders-stage-physics-cook)). The
field is additive: a file cooked before it has none, and format 2 still reads it. The node keeps its
`instances` entries: the page leaves them out once it has restored its body
(`packages/sdk-browser/src/physics/cookedBodies.ts`) and falls back on them when it refuses the
body; another node its collider names keeps its own, still static ground. Each entry:

- `node`: the declaring node.
- `motion`: the motion as the node declares it (`isKinematic`, `mass`, `gravityFactor`, …).
- `shape`: the `KHR_implicit_shapes` shape the collider names, as declared, or `cooked`: one
  `ConvexHullShape` for contact, a SHA-addressed object like a tile (`url`, `sha256`, `bytes`), in
  the body's frame at unit scale; and, a dynamic body's, `mass`, the exact weighing of the solid
  its closed mesh bounds at 1000 kg/m³ and at the body's `scale`: `mass` (kg), `centerOfMass` and
  `inertia` about it (nine numbers, column-major), in the body's frame — the mass the page hands
  Jolt, turning the hull about `centerOfMass` rather than about the hull's own centre, weighed
  again at the world scale the model is placed at; what the `motion` declares (`mass`,
  `centerOfMass`, `inertiaDiagonal` turned by `inertiaOrientation`) wins over it, the cooked
  inertia scaled to a declared mass.
- `position`, `rotation`, `scale`: the node's world placement in the model, as an instance's.
- `friction`, `restitution`: as an instance's.

`report.bodies` counts them; `report.bodiesRefused` lists each declaring node the cook refused
(`node`, `reason`): it has no body, and stays static ground.

### `softBodies` — cooked soft bodies

Stage version 5 adds `softBodies`, one entry per drawn node whose `extras.physics` declares a
cloth, a rope or a volume ([COMPILER.md](COMPILER.md#soft-bodies-a-model-declares)). The field is
additive: a file cooked before it has none, and format 2 still reads it. Each entry:

- `node`: the declaring node. It has no `instances` entry: a soft body is no static ground.
- `physics`: the options the node declares, as `obj.physics` takes them; the page reads the body's
  matter, pull and damping from them.
- `settings`: the body's `SoftBodySharedSettings` in Jolt's binary state (`SaveWithMaterials`), a
  SHA-addressed object like a tile (`url`, `sha256`, `bytes`); its vertices are already at
  `scale`, its compliances in it.
- `vertices`: simulated vertices, counted against `budget.physics.softVertices`.
- `pressure`: the gas's gauge pressure at rest, Pa; 0 for a cloth or a rope.
- `position`, `rotation`, `scale`: the node's world placement in the model, as an instance's.
- `friction`, `restitution`: as an instance's, those of the `physicsMaterial` its
  `KHR_physics_rigid_bodies` collider names, if any. A `friction` or `restitution` in `physics`
  wins over them, as `obj.physics` wins over its material; neither, and the engine's default
  matter.

`report.softBodies` counts them; `report.softRefused` lists each declaring node the cook refused
(`node`, `reason`, in the words the page would refuse it with): it has no body and no static
collider, and is drawn all the same. The page restores the settings and copies them into one SOFT
command (`packages/sdk-core/src/physics/softLayout.ts`); it builds nothing. A model the page moves
carries its soft bodies where it now is (TELEPORT), their simulation kept; placed or rescaled at
another scale than its nodes were cooked at, it has them released and refused (`PHYSICS_FAILED`),
for Jolt scales no soft body once made, and made again once back at that scale. Each takes the
flags a page-built one does, its model's visibility for its own.

## Source glTF

The compiler writes a compacted `source.gltf` + `source.bin` for the selected nodes. Relative image URIs are rewritten against the host `resourceBaseUrl`. `images` may be omitted. Images that use `bufferView` (no `uri`) keep their view; the view is copied into `source.bin`. Sparse accessors (`accessor.sparse`) are decoded and their bufferViews are compacted and remapped. Skinned meshes (`skin`, `JOINTS_0`, `WEIGHTS_0`), morph targets (`targets`), and animations are preserved in `source.gltf` and routed to the `shared-blend` reference pass.

## Source files

Input is a directory with `manifest.json`, a directory with exactly one `.gltf`/`.glb`, or a `.gltf`/`.glb` file. When `manifest.json` is present, `manifest.runtime.file` names the glTF JSON or GLB. For `.gltf`, the first buffer URI names the sidecar binary. Both names must be a single relative path segment (no `/`, `\\`, or `..`). The compiler verifies SHA-256 of the glTF against `runtime.sha256` and of the sidecar against the matching `runtime.sidecars[]` entry. A GLB carries its BIN chunk; sidecar hashes are not required. Without a manifest, hashes are computed from the files. Multiple glTF buffers are concatenated into one `source.bin` (4-byte padded) and `bufferView.buffer` is remapped to 0. Unknown layouts, data URIs as buffer URIs, and path escape are rejected. Unindexed triangle lists (`POSITION` count a multiple of three, no `indices`) are indexed during clustering. In `slice` scope, if no mesh instance fits the triangle budget, the smallest overflowing instance is kept.
