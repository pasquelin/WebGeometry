import { declaredLightingWgsl } from '../../lighting/direct/lightingWgsl.ts';
import { ROUGHNESS_FLOOR } from '../../lighting/shaderConstants.ts';
import { bounceApplyWgsl } from '../../bounce/applyWgsl.ts';
import { STANDARD_LIGHTING_WGSL, NORMAL_TRANSFORM_WGSL } from '../../lighting/standardLighting.ts';
import { TRIANGLE_PALETTE_WGSL } from '../../diagnostic/trianglePalette.ts';
import {
  COLOR_SAMPLE_WGSL,
  DATA_SAMPLE_WGSL,
  TILE_POOL_WGSL,
  tileDeclarations,
} from '../tile/wgsl.ts';
import { TILE_REQUEST_WGSL } from '../tile/requestWgsl.ts';
import { BLEND_BINDINGS } from '../core/bindLayout.ts';
import { BLEND_ITEM_WGSL } from './items.ts';
import { BLEND_REQUEST_WGSL } from './requestWgsl.ts';
import { FLAG_HAS_COLOR, FLAG_PAGED, FLAG_UNLIT_VIEW } from '../../visibility/buffer.ts';
import { VERTEX_COLOR_WGSL } from '../core/vertexColors.ts';
import { BLEND_SURFACE_WGSL } from './shaderSurface.ts';
import { LINE_CLIP_WGSL, LINE_DASH_WGSL } from '../../visibility/shader/lineWgsl.ts';
import { SPRITE_WGSL } from '../../visibility/shader/spriteWgsl.ts';
import { WATER_MAX_ITEMS, WATER_RANK_SHIFT } from '../water/surfaceWgsl.ts';
import { INSTANCE_CULL_SHIFT, INSTANCE_ITEM_MASK } from './runs.ts';
import { FACING_DROP, FACING_SHIFT, FACING_WGSL } from './facing.ts';

/**
 * Shader of transparent surfaces.
 *
 * Two inputs only: a view uniform, written once per image for the whole pass, and the item
 * record, read in a storage buffer at the rank the vertex index carries. Nothing is bound per
 * call, and the order of calls is that of the scene.
 */
/** The view uniform of the pass (`uniforms.ts`), declared once for every stage that
 *  reads it: the two forward stages here, and the water composite that reads the same buffer. */
export const BLEND_VIEW_WGSL = `struct BlendView{viewProj:mat4x4f,camPos:vec4f,lightTiles:vec2f,viewFlags:u32,vertexShift:u32,feedback:u32,pixelScale:f32,viewport:vec2f,eye:vec4f,pixelRatio:f32,}`;

export const BLEND_SHADER = `${BLEND_VIEW_WGSL}
${BLEND_ITEM_WGSL}
@group(0) @binding(${BLEND_BINDINGS.indices}) var<storage, read> indices:array<u32>;
@group(0) @binding(${BLEND_BINDINGS.positions}) var<storage, read> positions:array<f32>;
@group(0) @binding(${BLEND_BINDINGS.uvs}) var<storage, read> uvs:array<f32>;
@group(0) @binding(${BLEND_BINDINGS.uniform}) var<uniform> uni:BlendView;
@group(0) @binding(${BLEND_BINDINGS.items}) var<storage,read> items:array<BlendItem>;
${tileDeclarations(BLEND_BINDINGS.color, 'color')}
@group(0) @binding(${BLEND_BINDINGS.sampler}) var mapsSampler:sampler;
${tileDeclarations(BLEND_BINDINGS.data, 'data')}
@group(0) @binding(${BLEND_BINDINGS.normals}) var<storage,read> normals:array<f32>;
${VERTEX_COLOR_WGSL}
${STANDARD_LIGHTING_WGSL}
${declaredLightingWgsl(BLEND_BINDINGS.proxy, BLEND_BINDINGS.shadowData, BLEND_BINDINGS.shadowTransmittance)}
${bounceApplyWgsl(BLEND_BINDINGS.bounceGrid, BLEND_BINDINGS.probes)}
@group(0) @binding(${BLEND_BINDINGS.directLights}) var<storage,read> directLights:DirectLights;
@group(0) @binding(${BLEND_BINDINGS.shadowAtlas}) var shadowAtlas:texture_depth_2d_array;
@group(0) @binding(${BLEND_BINDINGS.shadowSampler}) var shadowSampler:sampler_comparison;
@group(0) @binding(${BLEND_BINDINGS.clusterDiagnostic}) var<storage,read> clusterDiagnostic:array<u32>;
@group(0) @binding(${BLEND_BINDINGS.planInstances}) var<storage,read> planInstances:array<vec2u>;
@group(0) @binding(${BLEND_BINDINGS.clusterSpans}) var<storage,read> clusterSpans:array<vec2u>;
@group(0) @binding(${BLEND_BINDINGS.tileLights}) var<storage,read> tileLights:array<u32>;
${TILE_POOL_WGSL}
${COLOR_SAMPLE_WGSL}
${DATA_SAMPLE_WGSL}
${TILE_REQUEST_WGSL}
// The blended colour, and the tile rank this pixel asks of the virtual textures, set in its own
// target: the fragment stage writes nothing to memory, it keeps its early reject.
struct BlendOut{@location(0) color:vec4f,@location(1) request:u32,}
${BLEND_REQUEST_WGSL}
${NORMAL_TRANSFORM_WGSL}
${LINE_CLIP_WGSL}
${LINE_DASH_WGSL}
${SPRITE_WGSL}
// What the vertex stage reads on the item record and the fragment stage re-reads as-is: the six
// maps, their factors and the flags. They are constant over the call, therefore FLAT — the
// fragment reads the same bits it used to read in the per-item uniform, with no per-call binding.
// \`water\` is the item's one-based transmissive rank, carried above its flags, zero for a blend;
// above it, the cull mode a doubtful triangle leaves to the fragment stage (facing.ts).
// \`alphaAo\` carries, after the alpha test and the occlusion strength, a dashed line's dash and gap.
struct VSOut{@builtin(position) position:vec4f,@location(0) color:vec4f,@location(1) uv:vec2f,@location(2) view:vec3f,@location(3) normal:vec3f,@location(4) tangent:vec3f,@location(5) bitangent:vec3f,@location(6) @interpolate(flat) tri:u32,@location(7) bary:vec3f,@location(8) @interpolate(flat) diagId:u32,@location(9) @interpolate(flat) ids:vec3u,@location(10) @interpolate(flat) maps:vec4u,@location(11) @interpolate(flat) alphaAo:vec4f,@location(12) @interpolate(flat) pbr:vec4f,@location(13) @interpolate(flat) emissive:vec4f,@location(14) @interpolate(flat) water:u32,}
${TRIANGLE_PALETTE_WGSL}
// An instance draws a paged cluster that compaction kept, or a piece of indices of a primitive
// that is not paged. The list plan expansion wrote says, for each, the item that carries it and
// what it draws (expandWgsl.ts).
//
// The rank of the first instance of the call is read in the high bits of the vertex index, and
// the local rank of the vertex in the low: the indirect argument of a slice starts at vertex
// base << vertexShift. That is what lets a whole slice fit in ONE call, with nothing to bind
// between two plan entries — firstInstance would say the same, but WebGPU only opens it to an
// indirect call under an extension.
${FACING_WGSL}
@vertex fn vs(@builtin(vertex_index) vertexIndex:u32,@builtin(instance_index) instance:u32)->VSOut{
 var out:VSOut;
 let slot=planInstances[(vertexIndex>>uni.vertexShift)+instance];
 let it=items[slot.x&${INSTANCE_ITEM_MASK}u];
 let cull=slot.x>>${INSTANCE_CULL_SHIFT}u;
 let local=vertexIndex&((1u<<uni.vertexShift)-1u);
 let flags=(it.flags&${WATER_MAX_ITEMS}u)|uni.viewFlags;
 out.color=it.color;
 out.ids=vec3u(it.mapIndex,flags,it.emissiveIndex);
 out.maps=vec4u(it.roughIndex,it.metalIndex,it.normalIndex,it.aoIndex);
 out.alphaAo=vec4f(it.alphaTest,it.aoIntensity,it.dash);
 out.pbr=vec4f(it.roughness,it.metalness,it.normalScale);
 out.emissive=vec4f(it.emissive.xyz,0.0);
 var base=slot.y;
 var count=it.indexCount-slot.y;
 var clusterId=0u;
 if((flags&${FLAG_PAGED}u)!=0u){
  let span=clusterSpans[slot.y];
  base=span.x;
  count=span.y;
  clusterId=clusterDiagnostic[slot.y];
 }
 var facing=0u;
 if(cull!=0u&&local<count){facing=vertexFacing(cull,it.world,it.vertexBase,base+(local/3u)*3u);}
 out.water=(it.flags>>${WATER_RANK_SHIFT}u)|(facing<<${FACING_SHIFT}u);
 if(local>=count||facing==${FACING_DROP}u){out.position=vec4f(0.0,0.0,2.0,1.0);out.color=vec4f(0.0);out.uv=vec2f(0.0);out.view=vec3f(0.0);out.normal=vec3f(0.0,0.0,1.0);out.tangent=vec3f(0.0);out.bitangent=vec3f(0.0);out.tri=0u;out.bary=vec3f(0.0);out.diagId=0u;return out;}
 let id=it.vertexBase+indices[base+local];
 // The material colour times the vertex colour, alpha included, as the forward path reads it.
 if((flags&${FLAG_HAS_COLOR}u)!=0u){out.color*=vertColor(id);}
 let world=it.world*vec4f(positions[id*3u],positions[id*3u+1u],positions[id*3u+2u],1.0);
 out.position=uni.viewProj*world;out.view=world.xyz;
 // A line quad widens on screen (\`lineClip\`), along the direction its corner's normal carries.
 if(it.lineWidth>0.0){out.position=lineClip(out.position,uni.viewProj*(it.world*vec4f(normals[id*7u],normals[id*7u+1u],normals[id*7u+2u],0.0)),it.lineWidth,uni.viewport,uni.pixelRatio);}
 // A sprite's quad turns to face the camera (\`spriteAt\`), about its origin.
 if(it.sprite.y!=0.0){let s=spriteAt(uni.viewProj,it.world,vec2f(positions[id*3u],positions[id*3u+1u]),it.sprite);out.position=uni.viewProj*s;out.view=s.xyz;}
 out.tri=0u;
 out.diagId=0u;
 if((flags&0x1c000000u)!=0u){out.diagId=clusterId;}
 if((flags&0x20000000u)!=0u){
  let triangle=base+(local/3u)*3u;
  let a=triangleHash(indices[triangle]);let b=triangleHash(indices[triangle+1u]);let c=triangleHash(indices[triangle+2u]);
  out.tri=a^((b<<1u)|(b>>31u))^((c<<2u)|(c>>30u));
 }
 let corner=local%3u;
 out.bary=select(select(vec3f(0.0,0.0,1.0),vec3f(0.0,1.0,0.0),corner==1u),vec3f(1.0,0.0,0.0),corner==0u);
 out.normal=vec3f(0.0);
 if((flags&16u)!=0u){out.normal=xformNormal(it.world,vec3f(normals[id*7u],normals[id*7u+1u],normals[id*7u+2u]));}
 out.tangent=vec3f(0.0);out.bitangent=vec3f(0.0);
 if((flags&256u)!=0u){out.normal=-out.normal;}
 if((flags&2048u)!=0u){
  out.tangent=uniteOuZero((it.world*vec4f(normals[id*7u+3u],normals[id*7u+4u],normals[id*7u+5u],0.0)).xyz);
  if((flags&256u)!=0u){out.tangent=-out.tangent;}
  out.bitangent=uniteOuZero(cross(out.normal,out.tangent)*normals[id*7u+6u]);
 }
 let i=id*2u;out.uv=vec2f(uvs[i],uvs[i+1u]);
 return out;
}
${BLEND_SURFACE_WGSL}
@fragment fn fs(in:VSOut,@builtin(front_facing) front:bool)->BlendOut{
 let flags=in.ids.y;
 // \`fwidth\` requires uniform control flow: the flags come from the per-item record, so the
 // derivative is taken before any condition that depends on it and is only read by the wireframe view.
 let width=fwidth(in.bary);
 let s=blendSurface(in,front);
 // A dashed line's gap (\`lineDash\`): its distance along the line rides the first coordinate.
 if(!lineDash(in.uv.x,in.alphaAo.zw)){discard;}
 if((flags&0x40000000u)!=0u){
  if(s.alpha<=0.01){discard;}
  var color=vec3f(0.204,0.827,0.6);
  if((flags&0x20000000u)!=0u){
   let edge=1.0-min(min(smoothstep(0.0,width.x*1.2,in.bary.x),smoothstep(0.0,width.y*1.2,in.bary.y)),smoothstep(0.0,width.z*1.2,in.bary.z));
   color=mix(hashColor(in.tri),vec3f(0.04,0.05,0.07),edge);
  }else if((flags&0x10000000u)!=0u){color=select(vec3f(0.5,0.55,0.6),hashColor(in.diagId&0x00ffffffu),in.diagId!=0u);}
  else if((flags&0x08000000u)!=0u){color=select(vec3f(0.04,0.51,0.94),vec3f(0.95,0.42,0.05),(in.diagId&0x80000000u)!=0u);}
  else if((flags&0x04000000u)!=0u){let ratio=f32((in.diagId>>24u)&127u)/127.0;color=vec3f(ratio,1.0-ratio,0.12);}
  return BlendOut(vec4f(color,1.0),s.request);
 }
 var rgb=s.rgb;
 // No declared lamp, or an unlit view requested: the raw albedo, exactly like the opaque
 // resolve. Neither ambient, nor sky, nor a default sun (P6).
 let unlit=(flags&${FLAG_UNLIT_VIEW}u)!=0u;
 let V=normalize(uni.camPos.xyz-in.view*uni.camPos.w);
 let clamped=clamp(s.rough,${ROUGHNESS_FLOOR},1.0);
 if(!unlit){
  if((flags&1u)!=0u){
   let m=clamp(s.metal,0.0,1.0);
   // A pixel's footprint at the surface: its distance times the pixel's angle, or the pixel
   // itself under an orthographic camera.
   shadowFootprint=select(uni.pixelScale,uni.pixelScale*length(uni.camPos.xyz-in.view),uni.camPos.w!=0.0);
   rgb=declaredLighting(rgb,m,clamped,s.N,V,in.view,s.ao,in.position.xy)+bounceLighting(rgb,m,s.N,in.view,s.ao)+environmentLighting(rgb,m,s.N,s.ao)+s.emissive;
  }
  // Lit or unlit, the surface is seen through the fog.
  rgb=fogged(rgb,in.view,uni.eye.xyz);
 }
 return BlendOut(vec4f(rgb,s.alpha),s.request);
}
`;
