/**
 * The arithmetic of the coverage-preserving alpha rule (docs/FORMAT.md, "Coverage-preserving alpha
 * (#44)"; `texture_preview/coverage.rs`), in the two shading languages of the card's chains, twin
 * for twin: WGSL for WebGPU, GLSL ES 3.0 for WebGL2 (#769). The scale: `median`, a level's alpha
 * byte as the compiler rounds it, `scaled`, step 4, and `reducedAlpha`, what a reduced texel
 * stores — the median alone without a cutoff, byte for byte as before. The pick: `pick`, step 3
 * over the level's histogram, `binOf(t)`, which the including
 * shader declares; its products pass 32 bits, so `wide` holds one as (high, low) words, `apart`
 * their distance, and `below` orders (error, distance to C, t) as the compiler's `min` does. The
 * cut (#43): `filtered`, the byte of a texel's bilinear sample `s` of the square of corner alphas
 * `a`, and `cutBin`, the highest `t` whose scale lifts that sample to `C` — the bin it is counted
 * in, coverage measured on the filtered cut, not on the texels —, searched between the square's
 * lowest and highest corners: a corner reaches `C` exactly when `t` is at most its byte.
 */
export const COVERAGE_SCALE_WGSL = `
fn toByte(x:f32)->u32{return u32(round(x*255.0));}
fn median(a:vec4f)->u32{
 let b=vec4u(toByte(a.x),toByte(a.y),toByte(a.z),toByte(a.w));
 return (min(max(b.x,b.y),max(b.z,b.w))+max(min(b.x,b.y),min(b.z,b.w))+1u)>>1u;
}
fn scaled(a:u32,c:u32,t:u32)->u32{return min(255u,u32((2u*a*(2u*c-1u)+2u*t-1u)/(4u*t-2u)));}
fn reducedAlpha(a:vec4f,c:u32,t:u32)->f32{
 if(c==0u){let u=min(max(a.x,a.y),max(a.z,a.w));let v=max(min(a.x,a.y),min(a.z,a.w));return (u+v)*0.5;}
 return f32(scaled(median(a),c,t))/255.0;
}`;
export const COVERAGE_PICK_WGSL = `
fn wide(a:u32,b:u32)->vec2u{
 let al=a&0xffffu;let ah=a>>16u;let bl=b&0xffffu;let bh=b>>16u;
 let mid=((al*bl)>>16u)+((al*bh)&0xffffu)+((ah*bl)&0xffffu);
 return vec2u(ah*bh+((al*bh)>>16u)+((ah*bl)>>16u)+(mid>>16u),(mid<<16u)|((al*bl)&0xffffu));
}
fn below(a:vec4u,b:vec4u)->bool{return a.x<b.x||(a.x==b.x&&(a.y<b.y||(a.y==b.y&&(a.z<b.z||(a.z==b.z&&a.w<b.w)))));}
fn apart(a:vec2u,b:vec2u)->vec2u{
 let swap=below(vec4u(a,0u,0u),vec4u(b,0u,0u));let hi=select(a,b,swap);let lo=select(b,a,swap);
 return vec2u(hi.x-lo.x-u32(hi.y<lo.y),hi.y-lo.y);
}
fn pick(c:u32,covered:u32,texels:vec2u)->u32{
 let goal=wide(covered,texels.y);var best=vec4u(0xffffffffu,0xffffffffu,255u,c);var above=0u;
 for(var t=255u;t>0u;t--){
  above+=binOf(t);let error=apart(wide(above,texels.x),goal);
  let next=vec4u(error.x,error.y,max(t,c)-min(t,c),t);
  if(below(next,best)){best=next;}
 }
 return best.w;
}`;

export const COVERAGE_CUT_WGSL = `
fn filtered(a:vec4u,s:u32)->u32{
 let x=3u-2u*(s&1u);let y=3u-2u*(s>>1u);
 return (y*(x*a.x+(4u-x)*a.y)+(4u-y)*(x*a.z+(4u-x)*a.w)+8u)>>4u;
}
fn cutBin(a:vec4u,s:u32,c:u32)->u32{
 var low=min(min(a.x,a.y),min(a.z,a.w));var high=max(max(a.x,a.y),max(a.z,a.w))+1u;
 while(high-low>1u){
  let t=(low+high)>>1u;
  if(filtered(vec4u(scaled(a.x,c,t),scaled(a.y,c,t),scaled(a.z,c,t),scaled(a.w,c,t)),s)>=c){low=t;}else{high=t;}
 }
 return low;
}`;

/** The GLSL ES 3.0 twins, line for line. */
export const COVERAGE_SCALE_GLSL = `
uint toByte(float x){return uint(round(x*255.));}
uint median(vec4 a){
 uvec4 b=uvec4(toByte(a.x),toByte(a.y),toByte(a.z),toByte(a.w));
 return (min(max(b.x,b.y),max(b.z,b.w))+max(min(b.x,b.y),min(b.z,b.w))+1u)>>1u;
}
uint scaled(uint a,uint c,uint t){return min(255u,uint((2u*a*(2u*c-1u)+2u*t-1u)/(4u*t-2u)));}
float reducedAlpha(vec4 a,uint c,uint t){
 if(c==0u){float u=min(max(a.x,a.y),max(a.z,a.w));float v=max(min(a.x,a.y),min(a.z,a.w));return (u+v)*0.5;}
 return float(scaled(median(a),c,t))/255.;
}`;
export const COVERAGE_PICK_GLSL = `
uvec2 wide(uint a,uint b){
 uint al=a&0xffffu;uint ah=a>>16u;uint bl=b&0xffffu;uint bh=b>>16u;
 uint mid=((al*bl)>>16u)+((al*bh)&0xffffu)+((ah*bl)&0xffffu);
 return uvec2(ah*bh+((al*bh)>>16u)+((ah*bl)>>16u)+(mid>>16u),(mid<<16u)|((al*bl)&0xffffu));
}
bool below(uvec4 a,uvec4 b){return a.x<b.x||(a.x==b.x&&(a.y<b.y||(a.y==b.y&&(a.z<b.z||(a.z==b.z&&a.w<b.w)))));}
uvec2 apart(uvec2 a,uvec2 b){
 bool swap=below(uvec4(a,0u,0u),uvec4(b,0u,0u));uvec2 hi=swap?b:a;uvec2 lo=swap?a:b;
 return uvec2(hi.x-lo.x-uint(hi.y<lo.y),hi.y-lo.y);
}
uint pick(uint c,uint covered,uvec2 texels){
 uvec2 goal=wide(covered,texels.y);uvec4 best=uvec4(0xffffffffu,0xffffffffu,255u,c);uint above=0u;
 for(uint t=255u;t>0u;t--){
  above+=binOf(t);uvec2 error=apart(wide(above,texels.x),goal);
  uvec4 next=uvec4(error.x,error.y,max(t,c)-min(t,c),t);
  if(below(next,best)){best=next;}
 }
 return best.w;
}`;
export const COVERAGE_CUT_GLSL = `
uint filtered(uvec4 a,uint s){
 uint x=3u-2u*(s&1u);uint y=3u-2u*(s>>1u);
 return (y*(x*a.x+(4u-x)*a.y)+(4u-y)*(x*a.z+(4u-x)*a.w)+8u)>>4u;
}
uint cutBin(uvec4 a,uint s,uint c){
 uint low=min(min(a.x,a.y),min(a.z,a.w));uint high=max(max(a.x,a.y),max(a.z,a.w))+1u;
 while(high-low>1u){
  uint t=(low+high)>>1u;
  if(filtered(uvec4(scaled(a.x,c,t),scaled(a.y,c,t),scaled(a.z,c,t),scaled(a.w,c,t)),s)>=c){low=t;}else{high=t;}
 }
 return low;
}`;
