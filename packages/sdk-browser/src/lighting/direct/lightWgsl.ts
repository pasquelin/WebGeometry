import { LIGHT_KIND, LIGHT_SETTINGS, POINT_FACES } from '../../../../sdk-core/src/index.ts';
import { ENVIRONMENT_COEFFICIENTS } from '../../../../sdk-core/src/scene/core/environment.ts';
import { RECT_LIGHT_WGSL } from './rectLightWgsl.ts';
import { LTC_SIZE } from '../../../../sdk-core/src/lighting/ltcTable.ts';

/** Words of a tile record: the two counts, then the two lists of `tileLights` each. */
export const TILE_STRIDE_WORDS = LIGHT_SETTINGS.tileLights * 2 + 2;

/**
 * Structures shared by the light-list pass and deferred resolve: a single GPU-side
 * declaration of the `SceneLight` contract, and a single physical attenuation. Shader
 * bounds come from the published settings, never from hand-written constants.
 */
export const DIRECT_LIGHT_WGSL = `
const TILE_SIZE:u32=${LIGHT_SETTINGS.tileSize}u;
/** A tile carries two lists: two header words — the count of each —, the opaque list, then
 *  the blend one, which covers a deeper depth slice. Each list holds \`TILE_LIGHTS\` lights; a
 *  count past it says the tile keeps no list and walks every light of the scene (\`tileLighting\`). */
const TILE_LIGHTS:u32=${LIGHT_SETTINGS.tileLights}u;
const TILE_STRIDE:u32=${TILE_STRIDE_WORDS}u;
const TILE_OPAQUE_BASE:u32=2u;
const TILE_BLEND_BASE:u32=${LIGHT_SETTINGS.tileLights + 2}u;
const POINT_FACES:u32=${POINT_FACES}u;
const SPOT_EDGE:f32=${LIGHT_SETTINGS.spotEdgeSoftness};
const KIND_SPOT:f32=${LIGHT_KIND.spot}.0;
const KIND_SUN:f32=${LIGHT_KIND.directional}.0;
struct DirectLight{positionRange:vec4f,colorIntensity:vec4f,directionCone:vec4f,params:vec4f,shape:vec4f,}
/** The count; the environment's irradiance: nine spherical-harmonic coefficients
 *  (\`packages/sdk-core/src/scene/core/environment.ts\`), zero where the host declared none; its fog,
 *  colour and mode then law (\`packages/sdk-core/src/scene/core/fog.ts\`); the fitted specular lobe
 *  a rectangle is integrated with, written once (\`ltcTable.ts\`); then every light, as many as
 *  the scene holds. */
struct DirectLights{count:u32,pad0:u32,pad1:u32,pad2:u32,environment:array<vec4f,${ENVIRONMENT_COEFFICIENTS}>,fog:array<vec4f,2>,ltc:array<vec4f,${LTC_SIZE * LTC_SIZE * 2}>,items:array<DirectLight>,}
/** The type rank is a float in the buffer: a single place knows how to reread it. */
fn isSun(light:DirectLight)->bool{return abs(light.params.x-KIND_SUN)<0.5;}
/** The range window at \`distance\` from a light's centre: one at the centre, zero at its range. */
fn rangeWindow(distance:f32,range:f32)->f32{
 let ratio=distance/range;
 return pow(clamp(1.0-ratio*ratio*ratio*ratio,0.0,1.0),2.0);
}
${RECT_LIGHT_WGSL}
/** Normalized direction toward the light and attenuation; w at zero when the point is out of
 *  range. A punctual light's: a rectangle has no one direction (\`rectIrradiance\`). */
fn directIncidence(light:DirectLight,P:vec3f)->vec4f{
 // A directional light has neither position nor range: the same irradiance at every point, never
 // attenuated by distance. Its direction is that of propagation, so incidence is the opposite.
 // The contract has already normalized it.
 if(isSun(light)){return vec4f(-light.directionCone.xyz,1.0);}
 let offset=light.positionRange.xyz-P;
 let distance=length(offset);
 let range=light.positionRange.w;
 if(distance>=range){return vec4f(0.0);}
 let L=offset/max(distance,1e-6);
 // Physical inverse square, windowed by range: energy cancels exactly at range.
 var attenuation=rangeWindow(distance,range)/max(distance*distance,1e-4);
 if(abs(light.params.x-KIND_SPOT)<0.5){
  let cosine=dot(-L,light.directionCone.xyz);
  let edge=light.directionCone.w;
  // A declared penumbra widens the fade inward to its inner cone; never narrower than the edge.
  attenuation*=smoothstep(edge,max(light.params.w,edge+SPOT_EDGE),cosine);
 }
 return vec4f(L,attenuation);
}
/** Major axis of the light-to-point direction, in POINT_FACE_AXES order. */
fn pointFaceOf(direction:vec3f)->u32{
 let a=abs(direction);
 if(a.x>=a.y&&a.x>=a.z){return select(1u,0u,direction.x>0.0);}
 if(a.y>=a.z){return select(3u,2u,direction.y>0.0);}
 return select(5u,4u,direction.z>0.0);
}`;
