import { STANDARD_LIGHTING_WGSL } from '../standardLighting.ts';
import { DIRECT_LIGHTING_WGSL } from '../direct/lightingWgsl.ts';
import { BOUNCE_APPLY_WGSL } from '../../bounce/applyWgsl.ts';
import {
  BOUNCE_SURFACE_BINDING,
  MIRROR_LIGHTING_WGSL,
  bounceReflectionWgsl,
} from '../../bounce/reflectWgsl.ts';
import { TONE_MAPPING_WGSL } from '../toneMappingWgsl.ts';
import { AS_IS_FLAG } from '../../scene/surfaceModel.ts';

export const FULLSCREEN_VERTEX = `@vertex fn fullscreen(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(f32(i32(i&1u)*4-1),f32(i32(i>>1u)*4-1),0.0,1.0);}`;
/** Last link of every composition: linear radiance carried into display space. */
const SRGB_WGSL = `
fn linearToSrgb(c:vec3f)->vec3f{return select(1.055*pow(max(c,vec3f(0.0)),vec3f(0.41666))-0.055,c*12.92,c<vec3f(0.0031308));}`;
/** View uniform, shared by both programs and by the water composite: `viewport` carries the
 *  size, the raw-output flag of diagnostic views and the rank of a sampled image
 *  (`../direct/lightSamplingWgsl.ts`); `lightParams` the contract light count, tiles in X and Y, and
 *  exposure, applied before the display curve (P4); `display.x` the rank of that curve
 *  (`../toneMappingWgsl.ts`), `display.yzw` the eye the fog is measured from. The environment's
 *  irradiance and fog travel with the lights. */
export const VIEW_WGSL = `struct View{inverseViewProjection:mat4x4f,camera:vec4f,viewport:vec4f,background:vec4f,lightParams:vec4f,display:vec4f,}`;
/** World position of a pixel at a depth, reconstructed through that view: the one reading of
 *  the depth buffer every fullscreen pass shares. */
export const WORLD_AT_WGSL = `
fn worldAt(pixel:vec2f,z:f32)->vec3f{
 let ndc=vec4f(pixel.x/view.viewport.x*2.0-1.0,1.0-pixel.y/view.viewport.y*2.0,z,1.0);
 let world=view.inverseViewProjection*ndc;
 return world.xyz/world.w;
}`;
/** The surfaces, their depth and the view: bindings 0 to 5 of every pass that lights a surface
 *  buffer — the deferred resolve, and the water composite on the same numbers. */
export const SURFACE_BINDINGS_WGSL = `
@group(0) @binding(0) var baseMetal:texture_2d<f32>;
@group(0) @binding(1) var normalRough:texture_2d<f32>;
@group(0) @binding(2) var emissiveAo:texture_2d<f32>;
@group(0) @binding(3) var flags:texture_2d<u32>;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var<uniform> view:View;`;
/**
 * Unlit view: material albedo as-is, with no light, no ambient and no emission. This is not
 * a light, it is a diagnostic view — the one geometry benches that compare images pixel for
 * pixel ask for, and the one the engine renders by default as long as no light is declared,
 * because a scene with no source has nothing to light (P6).
 */
export const UNLIT_LIGHTING_SHADER = `
${VIEW_WGSL}
${SURFACE_BINDINGS_WGSL}
${FULLSCREEN_VERTEX}
@fragment fn lightSurface(@builtin(position) pixel:vec4f)->@location(0) vec4f{
 let coord=vec2i(pixel.xy);let flag=textureLoad(flags,coord,0).r;
 if(flag==0u){return vec4f(0.0);}
 return vec4f(textureLoad(baseMetal,coord,0).rgb,1.0);
}`;
/** Contract bindings: declared lights, their per-tile lists and their shadow pool. The shadow
 *  records and page table, binding 8, are declared with the shadow read (`directShadowWgsl`). */
export const CONTRACT_BINDINGS_WGSL = `
@group(0) @binding(6) var<storage,read> directLights:DirectLights;
@group(0) @binding(7) var<storage,read> tileLights:array<u32>;
@group(0) @binding(9) var shadowAtlas:texture_depth_2d_array;
@group(0) @binding(10) var shadowSampler:sampler_comparison;`;
/** Shared body of the two contract programs: only the bounce lines separate them. */
const contractSurface = (bounce: string, diagnostic = '') => `
${FULLSCREEN_VERTEX}
${WORLD_AT_WGSL}
@fragment fn lightSurface(@builtin(position) pixel:vec4f)->@location(0) vec4f{
 let coord=vec2i(pixel.xy);let flag=textureLoad(flags,coord,0).r;
 if(flag==0u){return vec4f(0.0);}
 let base=textureLoad(baseMetal,coord,0);
 if(flag==${AS_IS_FLAG}u){return vec4f(base.rgb,1.0);}
 let z=textureLoad(depth,coord,0);
 let P=worldAt(pixel.xy,z);
 if(flag==1u){return vec4f(fogged(base.rgb,P,view.display.yzw),1.0);}
 let normal=textureLoad(normalRough,coord,0);let emissive=textureLoad(emissiveAo,coord,0);
 // The pixel's footprint at its depth, the unit its shadow level is chosen in.
 shadowFootprint=length(worldAt(pixel.xy+vec2f(1.0,0.0),z)-P);
 let V=normalize(view.camera.xyz-P*view.camera.w);let N=normalize(normal.xyz);
 surfaceModel=flag;
 ${diagnostic}
 let lit=contractLighting(base.rgb,base.a,normal.a,N,V,P,emissive.a,pixel.xy);
 let ambient=environmentLighting(base.rgb,base.a,N,emissive.a);
 return vec4f(fogged(lit+ambient+emissive.rgb${bounce},P,view.display.yzw),1.0);
}`;
/**
 * Contract program: deferred resolve lit by the declared lights only, with their shadows, seen
 * through the scene's fog. No ambient term, no constant sky, no light written in the scene is
 * added (P6). An unlit material shows its colour with no response to light, still seen through
 * the fog; a diagnostic, normal or depth surface comes out as-is.
 */
export const DIRECT_LIGHTING_SHADER = `
${VIEW_WGSL}
${SURFACE_BINDINGS_WGSL}
${CONTRACT_BINDINGS_WGSL}
${STANDARD_LIGHTING_WGSL}
${DIRECT_LIGHTING_WGSL}
${contractSurface('')}`;
/**
 * The same program, plus bounced light: probe irradiance multiplied by the pixel's diffuse
 * albedo, and what a mirror reflects (#31), added to the direct. It is a separate program, not a
 * branch, so a session without bounce runs exactly the previous shader, bit for bit.
 */
export const BOUNCE_LIGHTING_SHADER = `
${VIEW_WGSL}
${SURFACE_BINDINGS_WGSL}
${CONTRACT_BINDINGS_WGSL}
${STANDARD_LIGHTING_WGSL}
${DIRECT_LIGHTING_WGSL}
${BOUNCE_APPLY_WGSL}
${bounceReflectionWgsl(BOUNCE_SURFACE_BINDING)}
${MIRROR_LIGHTING_WGSL}
${contractSurface(
  '+bounceLighting(base.rgb,base.a,N,P,emissive.a)+mirrorLighting(base.rgb,base.a,normal.a,N,V,P)',
  'if(bounceOnly()){return vec4f(bounceIrradiance(N,P,view.lightParams.w),1.0);}',
)}`;
/**
 * How the composition reads a pixel's as-is share — 1 on a debug view (a normal or depth surface,
 * `AS_IS_FLAG`), 0 elsewhere —, binding 2, one read per pixel. A still image reads its surface
 * flag. An accumulated image reads the share the temporal pass resolved beside its colour, with the
 * same weights and history (`../../taa/shaderWgsl.ts`): the colour of an edge pixel is a history
 * blend, and its share follows it, so no pixel flips between the curve and none from one jitter to
 * the next.
 */
const AS_IS_READ = {
  still: {
    texture: 'texture_2d<u32>',
    share: `f32(textureLoad(asIs,coord,0).r==${AS_IS_FLAG}u)`,
  },
  accumulated: { texture: 'texture_2d<f32>', share: 'textureLoad(asIs,coord,0).r' },
} as const;
export type ComposeInput = keyof typeof AS_IS_READ;

/** The curved chain and the pixel as-is, weighed by its share: written out rather than `mix`, so a
 *  share of 1 yields the pixel as-is exactly, and selected, so a share of 0 yields the chain itself
 *  whatever the radiance holds. */
const asIsMix = (chaine: string, share: string) =>
  `let share=${share};let curved=${chaine};let untouched=value.rgb/max(value.a,1e-6);
 let color=linearToSrgb(select(curved,curved*(1.0-share)+untouched*share,share>0.0));`;

/**
 * Composition, one source for two separate programs — never a branch in the shader.
 * `chaine` is what linear radiance goes through before sRGB, and `courbe` what must be
 * declared for that. Background, premultiplication and the raw output of diagnostic views are shared,
 * and so are debug views: a curved chain is weighed back to the pixel as-is by its share
 * (`AS_IS_READ`), as the reference never exposes nor tone maps its normal or depth material. At a
 * share of 0 a lit pixel gets the chain before, bit for bit; the identity chain reads no share.
 */
const composeSource = (courbe: string, chaine: string, input: ComposeInput) => `
${VIEW_WGSL}
@group(0) @binding(0) var hdr:texture_2d<f32>;
@group(0) @binding(1) var<uniform> view:View;
${courbe ? `@group(0) @binding(2) var asIs:${AS_IS_READ[input].texture};` : ''}
${FULLSCREEN_VERTEX}
${SRGB_WGSL}${courbe}
fn composeColor(pixel:vec4f)->vec4f{
 let coord=vec2i(pixel.xy);
 let value=textureLoad(hdr,coord,0);
 if(value.a==0.0){return view.background;}
 if(view.viewport.z!=0.0){return vec4f(value.rgb,1.0);}
 ${courbe ? asIsMix(chaine, AS_IS_READ[input].share) : `let color=linearToSrgb(${chaine});`}
 return vec4f(color*value.a+view.background.rgb*(1.0-value.a),1.0);
}
@fragment fn compose(@builtin(position) pixel:vec4f)->@location(0) vec4f{return composeColor(pixel);}
struct DisplayOutput{@location(0) capture:vec4f,@location(1) canvas:vec4f,}
@fragment fn composePresent(@builtin(position) pixel:vec4f)->DisplayOutput{
 let color=composeColor(pixel);
 return DisplayOutput(color,color);
}`;
/** One composition per input: the still image's surface flags, or the accumulated share. */
const composeSources = (courbe: string, chaine: string) => ({
  still: composeSource(courbe, chaine, 'still'),
  accumulated: composeSource(courbe, chaine, 'accumulated'),
});
/**
 * Contract composition: exposure multiplies linear radiance before the display curve the scene
 * chose — ACES unless it chose another —, last link of the chain (P4). That is the one of
 * programs lit by declared lights.
 */
export const COMPOSE_SHADERS = composeSources(
  TONE_MAPPING_WGSL,
  'toneMap(value.rgb*view.lightParams.w/max(value.a,1e-6),u32(view.display.x))',
);
/**
 * Unlit-view composition: identity, from linear to sRGB and nothing else. With no declared
 * source there is no radiance to expose or bring into the display range (P6) — albedo is
 * read as-is, which is what benches that compare images pixel for pixel ask for.
 */
export const UNLIT_COMPOSE_SHADERS = composeSources('', 'value.rgb/max(value.a,1e-6)');
