import type { HostAttributes } from '../host/resources.ts';
import type { PageSurface } from '../page/surface.ts';
import type { Texture } from '../../../sdk-core/src/index.ts';
import type { MatrixElements } from '../math/matrixElements.ts';
import { HOST_FORMAT_RGBA } from '../host/surfaceConstants.ts';
import { texelFormatOf } from '../host/textureImport.ts';

export const VIS_INVALID = 0;
/**
 * Visibility identifier layout: `(pageRow + 1) << 8 | triangleIndex`, zero meaning background.
 *
 * A page is one cluster, and a cluster holds at most 128 triangles in a DAG cache and 256 in an older
 * cache, so eight bits index a triangle and the twenty-four remaining bits address the page. That is
 * 16.7 M pages instead of the 65 535 a 16/16 split allowed, which a scene replicated a few times
 * exhausts immediately.
 */
export const VIS_TRIANGLE_BITS = 8;
export const VIS_TRIANGLE_MASK = (1 << VIS_TRIANGLE_BITS) - 1;
/** Largest triangle count a page may carry; one more would collide with the next page's rows. */
export const VIS_MAX_PAGE_TRIANGLES = VIS_TRIANGLE_MASK + 1;
/** Largest addressable page count. Row `VIS_MAX_PAGES-1` still leaves 0xffffffff free as a sentinel. */
export const VIS_MAX_PAGES = 0xfffffe;
/** Rejects a page the identifier cannot address, naming the page so a bad cache is actionable. */
export function assertVisibilityPageTriangles(triangles: number, page?: string) {
  if (!Number.isInteger(triangles) || triangles < 0 || triangles > VIS_MAX_PAGE_TRIANGLES)
    throw new Error(
      `VISIBILITY_PAGE_TRIANGLES: ${triangles} triangles exceed the ${VIS_MAX_PAGE_TRIANGLES} a visibility identifier addresses${page ? ` (${page})` : ''}`,
    );
  return triangles;
}
export const PAGE_INFO_STRIDE = 256;
export const FLAG_LIT = 1,
  FLAG_DOUBLE = 2,
  FLAG_HAS_UV = 4,
  FLAG_HAS_MAP = 8,
  FLAG_HAS_NORMAL = 16,
  /** The row's pool slot holds this cluster's quantized geometry page (`WGP3`), not its index
   *  page: every corner, position and attribute is decoded from those words in place
   *  (`../cluster/decodeWgsl.ts`). A primitive the compiler gave no geometry page keeps the source
   *  float buffers, and its rows carry this bit at zero. */
  FLAG_CLUSTER_PAGE = 32,
  /** A map of the material has a filter word (`../webgpu/tile/sampling.ts`): its reads take the
   *  texture's filter rule. Without it, every read is the default one, and nothing else is run. */
  FLAG_SAMPLED = 64,
  FLAG_MASK = 128,
  FLAG_BACK = 256,
  FLAG_HAS_ORM = 512,
  FLAG_HAS_NORMAL_MAP = 1024,
  FLAG_HAS_TANGENT = 2048,
  /** The transparent draw reads its clusters from the compacted list, not an index buffer of its own. */
  FLAG_PAGED = 4096,
  /**
   * Frame flag, not a material one: the whole frame comes out as raw albedo because no light is
   * declared, or because the host asked for the unlit view. Only the transparent draw reads it —
   * the opaque path has its own resolve program for that.
   */
  FLAG_UNLIT_VIEW = 8192,
  /** The material transmits: the surface reads the already-drawn background instead of blending by alpha. */
  FLAG_TRANSMISSIVE = 16384,
  /** The material reads its vertex colours and the geometry carries some: the base colour is
   *  multiplied by the interpolated vertex colour, as the forward path does. */
  FLAG_HAS_COLOR = 32768,
  /** A shadow-only row of a blended cluster (`../webgpu/row/blendCasters.ts`): it writes no
   *  depth, only the transmittance of its coverage (`PageInfo.blendCoverage`,
   *  `../gpu/shadow/transmittance.ts`). */
  FLAG_BLEND_CASTER = 65536;
export type VisPage = {
  array: Uint32Array;
  attributes: HostAttributes;
  matrix: MatrixElements;
  /** The engine's surface record, read once at the boundary (`../page/surface.ts`). */
  material: PageSurface;
  clusterId?: string;
};

export type VisMaterial = {
  baseColor: [number, number, number];
  metalness: number;
  roughness: number;
  lit: boolean;
  doubleSided: boolean;
  backSide: boolean;
  alphaTest: number;
  map?: Texture;
  metalnessMap?: Texture;
  roughnessMap?: Texture;
  normalMap?: Texture;
  normalScale: number;
  normalScaleY: number;
  aoMap?: Texture;
  aoIntensity: number;
  emissive: [number, number, number];
  emissiveMap?: Texture;
  /** `KHR_materials_transmission.transmissionFactor`: the share of the background the surface lets through. */
  transmission: number;
  /** `KHR_materials_ior.ior`, and the volume of `KHR_materials_volume`. `attenuationDistance` is 0
   *  when the glTF does not declare one: the volume then attenuates nothing. */
  ior: number;
  thickness: number;
  attenuationDistance: number;
  attenuationColor: [number, number, number];
  /** The material multiplies its base colour by the geometry's `color` attribute, when it has one. */
  vertexColors?: boolean;
  /** The surface model a non-physical family maps onto (`../scene/surfaceModel.ts`); physical if absent. */
  model?: number;
  /** Width in CSS pixels the rasters widen a line quad to (`shader/lineWgsl.ts`); absent or
   *  zero on a surface that draws triangles. */
  lineWidth?: number;
  /** A dashed line's dash and gap along the line, in world units (`shader/lineWgsl.ts`,
   *  `lineDash`); absent on any other surface. */
  dashSize?: number;
  gapSize?: number;
  /** A sprite's quad, which every raster turns to face the camera (`shader/spriteWgsl.ts`): its
   *  turn in the image in radians, and whether it shrinks with distance; absent on any other
   *  surface. */
  sprite?: { rotation: number; sizeAttenuation: boolean };
};

export type UnpackedVisibility = { pageIndex: number; triangleIndex: number };

/**
 * CPU mirror of the packing the shaders write inline (`page.packedBase|(triangle&0xffu)` in
 * `shader/visWgsl.ts` and `../gpu/raster/pixelWgsl.ts`, `id>>8u` / `id&0xffu` at unpack in
 * `shader/shadeWgsl.ts`). Two languages: the text is not shared, the layout is.
 */
export function packVisibilityId(pageIndex: number, triangleIndex: number) {
  if (
    !Number.isInteger(pageIndex) ||
    pageIndex < 0 ||
    pageIndex >= VIS_MAX_PAGES ||
    !Number.isInteger(triangleIndex) ||
    triangleIndex < 0 ||
    triangleIndex > VIS_TRIANGLE_MASK
  )
    throw new Error('VISIBILITY_ID_RANGE');
  // The page field reaches past 2^31, so the shift is done in floating point and forced unsigned.
  return ((pageIndex + 1) * VIS_MAX_PAGE_TRIANGLES + (triangleIndex & VIS_TRIANGLE_MASK)) >>> 0;
}

export function unpackVisibilityId(id: number): UnpackedVisibility | null {
  if (id === VIS_INVALID) return null;
  return { pageIndex: (id >>> VIS_TRIANGLE_BITS) - 1, triangleIndex: id & VIS_TRIANGLE_MASK };
}

export { visMaterial, isTransmissive } from './shader/material.ts';

/** Why raw texels cannot be read as `textureRgba` reads them — one byte per channel of four, as
 *  many as the size holds —, or nothing when they can: a gate names the storage, never draws it
 *  blank. */
export const texelsReason = ({ format, image }: { format?: number; image: unknown }) => {
  if (format !== HOST_FORMAT_RGBA) return `texel format ${format} is unsupported: RGBA only`;
  const { data, width, height } = image as { data?: unknown; width: number; height: number };
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray))
    return 'texel storage is unsupported: 8-bit texels only';
  if (data.length !== width * height * 4)
    return `texel storage holds ${data.length} bytes, not ${width}×${height} RGBA`;
};

/** Why the texels a record holds in memory cannot be read as `textureRgba` reads them, in
 *  `texelsReason`'s words: its host's format for raw texels, RGBA for any other picture. The
 *  WebGPU fill throws it (#43), as the WebGL2 gate refuses the host by `texelsReason`. */
export const texelsRefusal = (texture: Texture) =>
  texelsReason({ format: texelFormatOf(texture) ?? HOST_FORMAT_RGBA, image: texture.image });

export type TextureRgba = { data: Uint8Array; width: number; height: number };
/**
 * Bytes of a texture, kept as long as it shows the same image. The rasterizer and the sample
 * call this per texel read: without a cache, each texel allocated a `Uint8Array` view and an
 * object. The source is rechecked every call — buffer, offset, length, width, height — so a
 * replaced image does yield the new bytes.
 */
const rgbaCache = new WeakMap<Texture, { source: ArrayBufferView; rgba: TextureRgba }>();

export function textureRgba(texture: Texture): TextureRgba | null {
  const image = texture.image as
    { data?: ArrayBufferView; width?: number; height?: number } | undefined;
  if (!image?.data || !image.width || !image.height) return null;
  const src = image.data;
  const held = rgbaCache.get(texture);
  if (
    held &&
    held.source === src &&
    held.rgba.width === image.width &&
    held.rgba.height === image.height &&
    held.rgba.data.buffer === src.buffer &&
    held.rgba.data.byteOffset === src.byteOffset &&
    held.rgba.data.byteLength === src.byteLength
  )
    return held.rgba;
  const rgba: TextureRgba = {
    data: new Uint8Array(src.buffer, src.byteOffset, src.byteLength),
    width: image.width,
    height: image.height,
  };
  rgbaCache.set(texture, { source: src, rgba });
  return rgba;
}
