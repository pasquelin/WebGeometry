import type { BlendGpuItem } from './state.ts';
import { refreshSurface } from '../../page/surface.ts';
import { layerSlot, sampledFlag, type MaterialLayers } from '../row/pageRowMaterial.ts';
import { writeSpriteWords } from '../../visibility/shader/spriteWgsl.ts';

/**
 * Record of a transparent item: everything a blend draw reads about IT, and nothing that
 * depends on the frame.
 *
 * These words move only if the scene moves — a matrix shifted, a material rewritten. A camera
 * that turns changes none of them. That is why they live in a storage buffer indexed by item
 * rank instead of a dynamically offset uniform: nothing left to write per frame, and no bind
 * group per draw.
 */
export const BLEND_ITEM_WORDS = 44;

/** Atlas tables the record cites: each texture's slot, per atlas, and the atlases. */
export type BlendAtlasTables = MaterialLayers;

/** Writes an item's record at its rank. `floats` and `ints` are two views of the same buffer. */
export function writeBlendItemRecord(
  floats: Float32Array,
  ints: Uint32Array,
  index: number,
  item: BlendGpuItem,
  tables: BlendAtlasTables,
) {
  const base = index * BLEND_ITEM_WORDS,
    // Read as the host holds it now: a surface rewritten in place is refilled here (#335).
    mat = refreshSurface(item.surface);
  const layer = layerSlot(tables.mapLayer, mat.map),
    emissive = layerSlot(tables.mapLayer, mat.emissiveMap),
    rough = layerSlot(tables.dataLayer, mat.roughnessMap),
    metal = layerSlot(tables.dataLayer, mat.metalnessMap),
    normal = layerSlot(tables.dataLayer, mat.normalMap),
    ao = layerSlot(tables.dataLayer, mat.aoMap);
  floats.set(item.matrix.elements, base);
  floats[base + 16] = mat.baseColor[0];
  floats[base + 17] = mat.baseColor[1];
  floats[base + 18] = mat.baseColor[2];
  floats[base + 19] = mat.opacity;
  // Where the instance reads what it draws, it takes it from the expanded list; the record now
  // carries only what belongs to the item — its indices, first vertex, flags, maps.
  ints[base + 20] = item.count;
  ints[base + 21] = item.vertexBase ?? 0;
  ints[base + 22] =
    item.flags | sampledFlag(tables.textures, layer, emissive, rough, metal, normal, ao);
  ints[base + 23] = layer;
  ints[base + 24] = emissive;
  floats[base + 25] = mat.lineWidth ?? 0;
  floats[base + 26] = mat.alphaTest;
  floats[base + 27] = mat.aoIntensity;
  floats[base + 28] = mat.roughness;
  floats[base + 29] = mat.metalness;
  floats[base + 30] = mat.normalScale;
  floats[base + 31] = mat.normalScaleY;
  ints[base + 32] = rough;
  ints[base + 33] = metal;
  ints[base + 34] = normal;
  ints[base + 35] = ao;
  floats[base + 36] = mat.emissive[0];
  floats[base + 37] = mat.emissive[1];
  floats[base + 38] = mat.emissive[2];
  floats[base + 39] = 0;
  // A dashed line's dash and gap (`lineDash`), zero on any other item.
  floats[base + 40] = mat.dashSize ?? 0;
  floats[base + 41] = mat.gapSize ?? 0;
  // A sprite's turn and size rule (`spriteAt`), zero on any other item.
  writeSpriteWords(floats, base + 42, mat.sprite);
}

/** WGSL declaration of the record, written once for the shader and for the layout. */
export const BLEND_ITEM_WGSL = `struct BlendItem{world:mat4x4f,color:vec4f,indexCount:u32,vertexBase:u32,flags:u32,mapIndex:u32,emissiveIndex:u32,lineWidth:f32,alphaTest:f32,aoIntensity:f32,roughness:f32,metalness:f32,normalScale:vec2f,roughIndex:u32,metalIndex:u32,normalIndex:u32,aoIndex:u32,emissive:vec4f,dash:vec2f,sprite:vec2f,}`;
