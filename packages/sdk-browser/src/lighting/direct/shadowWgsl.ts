import { LIGHT_SETTINGS, MAX_SHADOW_SLICES, POINT_FACES } from '../../../../sdk-core/src/index.ts';
import {
  LAMP_MIPS,
  PAGE_INDEX_MASK,
  PAGE_VALID,
  SHADOW_PAGE,
  SHADOW_TABLE_ENTRIES,
  SUN_LEVELS,
  lampMipOffset,
} from '../../../../sdk-core/src/scene/light-shadow/virtual.ts';
import { SHADOW_FACTOR_WGSL } from './shadowFactorWgsl.ts';
import { shadowThroughWgsl } from '../../gpu/shadow/transmittance.ts';

/** The PCF's taps, in texels around the read point. */
export const POISSON_16 = [
  [-0.94201624, -0.39906216],
  [0.94558609, -0.76890725],
  [-0.094184101, -0.9293887],
  [0.34495938, 0.2938776],
  [-0.91588581, 0.45771432],
  [-0.81544232, -0.87912464],
  [-0.38277543, 0.27676845],
  [0.97484398, 0.75648379],
  [0.44323325, -0.97511554],
  [0.53742981, -0.4737342],
  [-0.26496911, -0.41893023],
  [0.79197514, 0.19090188],
  [-0.2418884, 0.99706507],
  [-0.81409955, 0.9143759],
  [0.19984126, 0.78641367],
  [0.14383161, -0.1410079],
];

/** Farthest texel centre any tap weighs, in texels from the read point: the tap's offset plus
 *  the bilinear footprint's texel on each axis. The depth margin covers the receiver over it. */
export const PCF_REACH = Math.max(
  ...POISSON_16.map(([x, y]) => Math.hypot(Math.abs(x) + 1, Math.abs(y) + 1)),
);

/** Words of the request buffer past its list: the count first, then the entries the shading asked
 *  for — as many as the pool's `shadowRequestCap` —, then one bit per table entry: a page is listed
 *  once however many pixels read it. The list's length is the buffer's, read at run time. */
export const SHADOW_REQUEST_BITS = SHADOW_TABLE_ENTRIES / 32;

/**
 * The shadow buffer as the GPU reads it: every slice's record (`SHADOW_RECORD_FLOATS`) — lamp
 * faces, the sun's frame, the window origin of each clipmap slot two by two, then the header —,
 * then the page table, one word per virtual page. One binding for both: the blend stage has no
 * storage binding to spare.
 */
const SHADOW_DATA_WGSL = `struct ShadowRecord{faces:array<mat4x4f,${POINT_FACES}>,frame:array<vec4f,3>,origins:array<vec4i,${SUN_LEVELS / 2}>,info:vec4f,}
struct ShadowData{records:array<ShadowRecord,${MAX_SHADOW_SLICES}>,table:array<u32>,}`;

/**
 * What a reading asks of the scheduler. The shading that marks writes the page into the request
 * buffer the first time any pixel reads it this frame — a bit per table entry, tested before the
 * atomic, so a page thousands of pixels read costs one list slot. A pass that does not mark —
 * the blend forward stage, which keeps its early depth reject — reads without asking.
 */
const requestWgsl = (binding: number | null) =>
  binding === null
    ? 'fn requestShadowPage(e:u32){}'
    : `@group(0) @binding(${binding}) var<storage,read_write> shadowRequests:array<atomic<u32>>;
fn requestShadowPage(e:u32){
 let cap=arrayLength(&shadowRequests)-${1 + SHADOW_REQUEST_BITS}u;
 let word=1u+cap+(e>>5u);let bit=1u<<(e&31u);
 if((atomicLoad(&shadowRequests[word])&bit)!=0u){return;}
 if((atomicOr(&shadowRequests[word],bit)&bit)!=0u){return;}
 let at=atomicAdd(&shadowRequests[0],1u);
 if(at<cap){atomicStore(&shadowRequests[1u+at],e);}
}`;

/**
 * The virtual shadow read, shared by every pass that lights a surface: records and page table,
 * requests, the pool, and a PCF whose taps each find their own physical page.
 *
 * A map is `ShadowMap`: its first table entry, whether it is a ring — a sun level, whose pages
 * are addressed by absolute page modulo the window, `(ox, oy)` its origin — or a lamp face mip,
 * clamped at its edge, and its pages per side. Texel coordinates are relative to the map's first
 * page, texel centres at `+0.5`.
 *
 * A tap whose bilinear footprint lies in one page is one hardware comparison in that page; one
 * that straddles a seam is split along it (\`shadowPcf\`): no seam, no guard band.
 *
 * The filtered result is multiplied by the transmittance layer once, at the footprint's centre
 * (\`shadowThroughLit\`, \`../../gpu/shadow/transmittance.ts\`): its two textures are bound at
 * \`transmittanceBinding\` and the number after it. A pool without that layer binds one-texel
 * stand-ins, which the PCF never reads: its result is that of before, bit for bit.
 */
export const directShadowWgsl = (
  dataBinding: number,
  requestBinding: number | null,
  transmittanceBinding: number,
) => `
${SHADOW_DATA_WGSL}
@group(0) @binding(${dataBinding}) var<storage,read> shadows:ShadowData;
${requestWgsl(requestBinding)}
const PCF_TAPS:u32=${LIGHT_SETTINGS.pcfTaps}u;
const SHADOW_NORMAL_TEXELS:f32=${LIGHT_SETTINGS.shadowNormalOffsetTexels};
const SHADOW_PCF_REACH:f32=${PCF_REACH};
const SHADOW_PAGE:f32=${SHADOW_PAGE}.0;
const PAGE_VALID:u32=${PAGE_VALID}u;
const PAGE_INDEX_MASK:u32=${PAGE_INDEX_MASK}u;
const LAMP_MIP_OFFSET:array<u32,${LAMP_MIPS}>=array<u32,${LAMP_MIPS}>(${Array.from({ length: LAMP_MIPS }, (_, mip) => `${lampMipOffset(mip)}u`).join(',')});
const POISSON:array<vec2f,${LIGHT_SETTINGS.pcfTaps}>=array<vec2f,${LIGHT_SETTINGS.pcfTaps}>(${POISSON_16.map(
  ([x, y]) => `vec2f(${x},${y})`,
).join(',')});
/** Pixel footprint at the lit point, in metres: set by the pass before it lights a surface. */
var<private> shadowFootprint:f32=0.0;
/** Offset along the normal, in texels of the level read, of a receiver at incidence \`cosine\`:
 *  half a texel, plus, past 45°, the part of its plane's slope the depth margin leaves. */
fn shadowNormalTexels(cosine:f32)->f32{
 return SHADOW_NORMAL_TEXELS+SHADOW_PCF_REACH*max(sqrt(1.0-cosine*cosine)-cosine,0.0);
}
/** Depth margin, in metres toward the light, of a receiver whose depth changes by \`slope\` per
 *  unit across the map: its plane over the PCF's reach, up to \`cap\`, a slope of 1 in the
 *  caller's units. ADDED to the reference: shadow depth is reversed. */
fn shadowDepthMargin(texel:f32,slope:f32,cap:f32)->f32{return texel*SHADOW_PCF_REACH*min(slope,cap);}
struct ShadowMap{base:u32,ring:u32,pages:i32,ox:i32,oy:i32,}
fn shadowRing(v:i32,n:i32)->i32{return ((v%n)+n)%n;}
/** Word of page \`p\` of the map — asked for —, or zero when it holds nothing readable: unmapped,
 *  not drawn yet, or withdrawn while its depth is wrong — asked for again, never read. */
fn shadowPageWord(m:ShadowMap,p:vec2i)->u32{
 var e=0;
 if(m.ring!=0u){
  if(any(p<vec2i(0))||any(p>=vec2i(m.pages))){return 0u;}
  e=i32(m.base)+shadowRing(p.y+m.oy,m.pages)*m.pages+shadowRing(p.x+m.ox,m.pages);
 }else{
  let q=clamp(p,vec2i(0),vec2i(m.pages-1));
  e=i32(m.base)+q.y*m.pages+q.x;
 }
 requestShadowPage(u32(e));
 let word=shadows.table[u32(e)];
 return select(0u,word,(word&PAGE_VALID)!=0u);
}
/** Place of page \`p\`, held by physical page \`word\`: \`xy\` added to a texel coordinate of the
 *  map gives that texel's place in its layer, \`z\` is the layer (\`shadowPoolShape\`). */
fn shadowOffset(word:u32,p:vec2i)->vec3f{
 let phys=word&PAGE_INDEX_MASK;let side=textureDimensions(shadowAtlas).x/u32(SHADOW_PAGE);
 let local=phys%(side*side);
 return vec3f((vec2f(f32(local%side),f32(local/side))-vec2f(p))*SHADOW_PAGE,f32(phys/(side*side)));
}
/** Texels a side of a layer of the pool, derived from the screen (\`shadowPoolSize\`). */
fn shadowAtlasTexels()->f32{return f32(textureDimensions(shadowAtlas).x);}
${shadowThroughWgsl(transmittanceBinding)}
fn shadowCompare(offset:vec3f,t:vec2f,reference:f32)->f32{
 return textureSampleCompareLevel(shadowAtlas,shadowSampler,(offset.xy+t)/shadowAtlasTexels(),i32(offset.z),reference);
}
/** Offset of the neighbour page \`p\` and 1 when it is readable; else the home page's and 0. */
fn shadowNeighbour(m:ShadowMap,p:vec2i,home:vec3f)->vec4f{
 let word=shadowPageWord(m,p);
 if(word==0u){return vec4f(home,0.0);}
 return vec4f(shadowOffset(word,p),1.0);
}
/**
 * Sixteen taps a texel apart around \`t\`; a lamp face clamps them at its edge (\`side\` > 0).
 * Every tap's bilinear footprint lies within 1.5 texels of \`t\`, so the filter reaches at most
 * the home page's neighbours across the one or two edges that close: their words are read, and
 * asked for, once per pixel, before the taps. Away from any edge — all but the pixels within two
 * texels of one — each tap is one hardware comparison in the home page.
 *
 * Near an edge a tap is split along the seam, never texel by texel: each page's share of the
 * bilinear weight across the seam, \`saturate(0.5 + distance to the seam)\`, multiplies one
 * hardware comparison in that page, clamped to its last texel centre on that axis, the other axis
 * still filtered by the sampler. A tap is thus two comparisons beside one edge, four at a corner,
 * which the pixel decides once for all its taps. A neighbour not readable is read at the home page's nearest texel.
 */
fn shadowPcf(m:ShadowMap,t:vec2f,reference:f32,home:vec2i,homeWord:u32,side:f32)->f32{
 let first=vec2f(home)*SHADOW_PAGE;
 let edge=(t-1.5<first)|(t+1.5>=first+SHADOW_PAGE);
 let offset=shadowOffset(homeWord,home);
 var lit=0.0;
 if(!any(edge)){
  let texels=shadowAtlasTexels();let uv=(offset.xy+t)/texels;let layer=i32(offset.z);
  for(var tap=0u;tap<PCF_TAPS;tap++){
   lit+=textureSampleCompareLevel(shadowAtlas,shadowSampler,uv+POISSON[tap]/texels,layer,reference);
  }
  return shadowThroughLit(offset+vec3f(t,0.0),reference,lit/f32(PCF_TAPS));
 }
 let up=t-first>=vec2f(0.5*SHADOW_PAGE);
 let step=select(vec2i(-1),vec2i(1),up);
 let toward=select(vec2f(-1.0),vec2f(1.0),up);
 let seam=first+select(vec2f(0.0),vec2f(SHADOW_PAGE),up);
 var nx=vec4f(offset,0.0);var ny=nx;var nd=nx;
 if(edge.x){nx=shadowNeighbour(m,home+vec2i(step.x,0),offset);}
 if(edge.y){ny=shadowNeighbour(m,home+vec2i(0,step.y),offset);}
 if(all(edge)){nd=shadowNeighbour(m,home+step,offset);}
 for(var tap=0u;tap<PCF_TAPS;tap++){
  var at=t+POISSON[tap];
  if(side>0.0){at=clamp(at,vec2f(0.5),vec2f(side-0.5));}
  let h=clamp(at,first+0.5,first+SHADOW_PAGE-0.5);
  let n=select(min(at,seam-0.5),max(at,seam+0.5),up);
  let w=saturate(0.5+(seam-at)*toward);
  var sum=w.x*w.y*shadowCompare(offset,h,reference);
  if(edge.x){sum+=(1.0-w.x)*w.y*shadowCompare(nx.xyz,vec2f(select(h.x,n.x,nx.w>0.0),h.y),reference);}
  if(edge.y){sum+=w.x*(1.0-w.y)*shadowCompare(ny.xyz,vec2f(h.x,select(h.y,n.y,ny.w>0.0)),reference);}
  if(all(edge)){sum+=(1.0-w.x)*(1.0-w.y)*shadowCompare(nd.xyz,select(h,n,nd.w>0.0),reference);}
  lit+=sum;
 }
 return shadowThroughLit(offset+vec3f(t,0.0),reference,lit/f32(PCF_TAPS));
}
${SHADOW_FACTOR_WGSL}`;
