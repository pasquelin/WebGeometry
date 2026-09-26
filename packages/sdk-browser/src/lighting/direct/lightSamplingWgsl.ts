import { LIGHT_SETTINGS } from '../../../../sdk-core/src/index.ts';
import { HASH_UNIT_WGSL } from '../../math/hashUnitWgsl.ts';

/** Ranks a sampled image cycles through: past that many, the offset walks the same path again. */
export const SAMPLED_RANKS = 1024;

/**
 * Sampled resolve of a tile's opaque light list, for a MOVING image that temporal
 * antialiasing accumulates. Every light of the list is weighed without its shadow — the
 * cheap part —, and only `LIGHT_SAMPLES` of them are shaded in full, shadow read included —
 * the dear part. The estimate is unbiased: averaged over the images the history blends, it
 * converges to the sum over every light, which a still image computes in full.
 *
 * Two kinds of light in a pixel. A light whose share of the pixel's weight reaches one
 * sample's worth is shaded **exactly** and leaves the pool: it would be drawn every image
 * anyway, and drawing it a varying number of times is what would make a sunlit wall flicker.
 * The remaining samples are drawn from the rest, stratified — evenly spaced along the
 * cumulative weight from a per-pixel offset that advances by the golden ratio every image, so
 * one pixel walks its list evenly over time and its neighbours start elsewhere. Each drawn
 * light is divided by its probability; a light drawn twice counts twice. At most `LIGHT_SAMPLES`
 * shadows are read either way, and a list of that many lights or fewer is summed in full.
 *
 * `hashUnit` is the engine's integer hash: the offset depends on the pixel and the image rank
 * only, so a replayed image is the same image, and two runs give the same sequence. The rank
 * is bounded by the caller (`SAMPLED_RANKS`): a large one would eat the fraction's precision.
 */
export const DIRECT_LIGHT_SAMPLING_WGSL = `
const LIGHT_SAMPLES:u32=${LIGHT_SETTINGS.samplesPerPixel}u;
const LUMINANCE:vec3f=vec3f(0.2126,0.7152,0.0722);
const GOLDEN_RATIO:f32=0.61803399;
${HASH_UNIT_WGSL}
/** Unshadowed weight of a light at the point: its share of the pixel's drawing. Zero exactly
 *  when the unshadowed contribution is — out of range, or behind the surface —, so no light
 *  that could contribute is ever left undrawable. */
fn lightWeight(light:DirectLight,N:vec3f,P:vec3f)->f32{
 if(isRect(light)){return light.colorIntensity.w*rectIrradiance(light,P,N).w*dot(light.colorIntensity.rgb,LUMINANCE);}
 let incidence=directIncidence(light,P);
 return light.colorIntensity.w*incidence.w*max(dot(N,incidence.xyz),0.0)*dot(light.colorIntensity.rgb,LUMINANCE);
}
fn sampledTileLighting(rgb:vec3f,metal:f32,rough:f32,N:vec3f,V:vec3f,P:vec3f,ao:f32,tile:vec2u,tilesX:u32,rank:u32,pixel:vec2f)->vec3f{
 let base=(tile.y*tilesX+tile.x)*TILE_STRIDE;
 let kept=tileLights[base];
 // A tile past its list walks every light, exactly.
 if(kept>TILE_LIGHTS){return sceneLighting(rgb,metal,rough,N,V,P,ao);}
 if(kept<=LIGHT_SAMPLES){return tileLighting(rgb,metal,rough,N,V,P,ao,tile,tilesX,0u,TILE_OPAQUE_BASE);}
 var weights:array<f32,TILE_LIGHTS>;
 var total=0.0;
 for(var index=0u;index<kept;index++){
  weights[index]=lightWeight(directLights.items[tileLights[base+TILE_OPAQUE_BASE+index]],N,P);
  total+=weights[index];
 }
 if(total<=0.0){return vec3f(0.0);}
 // The lights to shade and what each one weighs: exact ones first, then the drawn ones. The
 // shading loop below is the same for every pixel of the group — one call per slot, each
 // pixel reading its own light — where a call inside the walk would run once per light any
 // pixel of the group drew, and the walk would then cost what it was meant to save.
 var chosen:array<u32,LIGHT_SAMPLES>;
 var factors:array<f32,LIGHT_SAMPLES>;
 var used=0u;
 var pool=0.0;
 var last=0u;
 for(var index=0u;index<kept;index++){
  if(weights[index]*f32(LIGHT_SAMPLES)>=total){
   chosen[used]=index;factors[used]=1.0;used+=1u;weights[index]=0.0;
  }else if(weights[index]>0.0){pool+=weights[index];last=index;}
 }
 let samples=LIGHT_SAMPLES-used;
 if(samples>0u&&pool>0.0){
  let offset=fract(hashUnit(u32(pixel.y)*65536u+u32(pixel.x))+f32(rank)*GOLDEN_RATIO);
  var running=0.0;
  var drawn=0u;
  var next=offset/f32(samples)*pool;
  for(var index=0u;index<kept&&drawn<samples;index++){
   let weight=weights[index];
   if(weight<=0.0){continue;}
   running+=weight;
   // Every sample that falls in this light's stratum draws it once; the last light of the
   // pool takes what rounding left behind, so no sample is ever lost.
   while(drawn<samples&&(next<running||index==last)){
    chosen[used]=index;factors[used]=pool/(f32(samples)*weight);used+=1u;
    drawn+=1u;next=(f32(drawn)+offset)/f32(samples)*pool;
   }
  }
 }
 var result=vec3f(0.0);
 for(var slot=0u;slot<used;slot++){
  let light=directLights.items[tileLights[base+TILE_OPAQUE_BASE+chosen[slot]]];
  result+=declaredLight(light,rgb,metal,rough,N,V,P,ao)*factors[slot];
 }
 return result;
}`;
