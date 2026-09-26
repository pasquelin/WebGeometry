import { BOUNCE_SETTINGS } from '../../../sdk-core/src/index.ts';
import { DIRECT_LIGHT_WGSL } from '../lighting/direct/lightWgsl.ts';
import { BOUNCE_GRID_WGSL, INVERSE_PI_WGSL } from './gridWgsl.ts';
import { PROXY_ALBEDO_WGSL, residentProxyWgsl } from './nodeWgsl.ts';
import { BOUNCE_TRACE_WGSL } from './traceWgsl.ts';

/** Threads of a cache-pass workgroup: one texel per thread. */
export const SURFACE_WORKGROUP = 64;
/** Surface-cache texels: two faces per proxy triangle, at least one. */
export const surfaceCacheTexels = (triangleCount: number) => Math.max(1, triangleCount * 2);
/**
 * Cache bytes, the single source of truth: the pass that creates it and the binding plan
 * read the same formula. A texel holds a `vec4f` — the face's outgoing radiance and its flag.
 */
export const surfaceCacheBytes = (triangleCount: number) => surfaceCacheTexels(triangleCount) * 16;
/** Label of the measured pass; it joins the "Bounce" step like the probe pass. */
export const BOUNCE_SURFACE_PASS = 'Trillion3D bounce surface cache v1';

/**
 * Proxy surface cache (LR5): one outgoing radiance per triangle and per face.
 *
 * Without it, every probe ray that hit a surface replayed every light and all of their
 * shadow rays there: five proxy traversals per ray instead of one, and the same point
 * re-evaluated as many times as rays hit it. The cache pays that work once per texel, on
 * a fixed per-frame budget, and the ray has only a read left. Multiple bounce becomes
 * free: the texel already carries the previous round's indirect, reread from the probe grid.
 *
 * The texel is the proxy triangle itself, whose size the compiler bounds: that is what
 * gives the cache a known resolution in metres, with no atlas and no projection. Both
 * faces are held separately — a wall is not lit the same on both sides, and the proxy is two-sided.
 *
 * Nothing is baked: the cache is rebuilt by sweep as soon as a light changes, the way a
 * shadow map is redrawn. A still scene updates no texel.
 */
export const BOUNCE_SURFACE_SHADER = `
struct SurfaceSpan{span:vec4u,}
@group(0) @binding(0) var<uniform> bounce:BounceGrid;
${residentProxyWgsl(1)}
@group(0) @binding(2) var<storage,read> proxyAlbedo:array<u32>;
@group(0) @binding(3) var<storage,read> directLights:DirectLights;
@group(0) @binding(4) var<storage,read> probes:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> surface:array<vec4f>;
@group(0) @binding(6) var<uniform> cursor:SurfaceSpan;
${DIRECT_LIGHT_WGSL}
${BOUNCE_GRID_WGSL}
${BOUNCE_TRACE_WGSL}
${PROXY_ALBEDO_WGSL}
const LIGHTS_PER_TEXEL:u32=${BOUNCE_SETTINGS.lightsPerRay}u;
${INVERSE_PI_WGSL}
/**
 * Irradiance of the declared lights at a texel point. Shadows are traced against the proxy,
 * which keeps a closed door closed for bounce as for the direct term; the shadow-ray count
 * is capped, and what it skips is skipped in light order, hence deterministically.
 */
fn directIrradiance(P:vec3f,N:vec3f,reach:f32)->vec3f{
 var total=vec3f(0.0);
 var shadows=0u;
 let count=directLights.count;
 let offset=P+N*1e-3;
 for(var index=0u;index<count;index++){
  let light=directLights.items[index];
  // A rectangle casts no shadow: its irradiance is its whole contribution.
  if(isRect(light)){total+=light.colorIntensity.rgb*light.colorIntensity.w*rectIrradiance(light,P,N).w;continue;}
  let incidence=directIncidence(light,P);
  if(incidence.w<=0.0){continue;}
  let cosine=dot(N,incidence.xyz);
  if(cosine<=0.0){continue;}
  if(light.params.z>0.5&&shadows<LIGHTS_PER_TEXEL){
   shadows++;
   let span=select(length(light.positionRange.xyz-P),reach,isSun(light));
   if(proxyBlocked(offset,incidence.xyz,span)){continue;}
  }
  total+=light.colorIntensity.rgb*light.colorIntensity.w*incidence.w*cosine;
 }
 return total;
}
@compute @workgroup_size(${SURFACE_WORKGROUP})
fn updateSurface(@builtin(global_invocation_id) id:vec3u){
 let total=arrayLength(&surface);
 if(id.x>=cursor.span.y||total==0u){return;}
 let texel=(cursor.span.x+id.x)%total;
 let triangle=texel>>1u;
 // Face zero: the geometric-normal side. Face one: the other. The source winding
 // order never comes into play — it is reliable on no imported scene.
 let normal=select(proxyNormal(triangle),-proxyNormal(triangle),(texel&1u)==1u);
 let point=proxyCentre(triangle);
 let reach=bounce.reach.x;
 // Exact direct of the frame, plus the indirect the grid has already converged: that is
 // the term that closes the bounce series, one more order on every sweep.
 let irradiance=directIrradiance(point,normal,reach)+sampleBounce(point,normal);
 surface[texel]=vec4f(proxyAlbedoOf(triangle)*irradiance*INVERSE_PI,1.0);
}`;
