/**
 * The names a WGSL text uses that it declares nowhere: what a device refuses to compile as an
 * unresolved value or an unresolved call. A small reader of the text, not a compiler: it takes
 * every declaration of the module (functions, structures, aliases, constants, variables and
 * parameters) as in scope everywhere, and WGSL's own words as always in scope, so it misses a
 * name used outside its function but never flags a name the text does declare. It checks names
 * only: a member a structure lacks, a wrong type or a name declared twice passes it.
 */

/** WGSL's own words: keywords, types, address spaces, access modes, texel formats, built-in
 *  functions. The only names a shader uses without declaring them. */
const WGSL_OWN = new Set(
  (
    'alias array atomic bitcast bool break case const continue continuing default diagnostic ' +
    'discard else enable f16 f32 false fn for function i32 if let loop mat2x2f mat3x3f mat4x4f ' +
    'override private ptr read read_write return sampler sampler_comparison storage struct ' +
    'switch true u32 uniform var vec2 vec3 vec4 vec2f vec3f vec4f vec2i vec3i vec4i vec2u vec3u ' +
    'vec4u while workgroup write ' +
    'texture_2d texture_2d_array texture_3d texture_cube texture_depth_2d texture_depth_2d_array ' +
    'texture_storage_2d texture_storage_2d_array texture_multisampled_2d ' +
    'r32float r32uint rg32float rgba8unorm rgba16float rgba32float rgba32uint ' +
    'abs acos all any arrayLength asin atan atan2 atomicAdd atomicAnd atomicCompareExchangeWeak atomicLoad ' +
    'atomicMax atomicMin atomicOr atomicStore atomicSub ceil clamp cos countLeadingZeros countOneBits cross ' +
    'degrees determinant distance dot dpdx dpdy exp exp2 extractBits faceForward firstLeadingBit ' +
    'floor fma fract fwidth insertBits inverseSqrt ldexp length log log2 max min mix normalize ' +
    'pack2x16float pack4x8unorm pow reflect refract reverseBits round saturate select sign sin ' +
    'smoothstep sqrt step storageBarrier tan tanh textureDimensions textureGather textureLoad ' +
    'textureNumLevels textureSample textureSampleBias textureSampleCompare ' +
    'textureSampleCompareLevel textureSampleGrad textureSampleLevel textureStore transpose ' +
    'trunc unpack2x16float unpack4x8unorm workgroupBarrier workgroupUniformLoad'
  ).split(/\s+/),
);

/** Every name the module declares: its functions, structures, aliases, constants and variables,
 *  module-scope or local, and, once member names and case colons are gone, every name a type
 *  follows — a parameter or a typed declaration. */
function declaredNames(code: string) {
  const declares = /\b(?:fn|struct|alias|const|let|var(?:\s*<[^>]*>)?|override)\s+(\w+)|(\w+)\s*:/g;
  return new Set([...code.matchAll(declares)].map((m) => m[1] ?? m[2]));
}

/** The names `source` uses and declares nowhere, sorted: comments, attributes and structure
 *  member names left out (their types kept, and an attribute's argument unless it is a
 *  built-in's, an interpolation's or a diagnostic's word), a case selector never taken for a
 *  declaration, a member after a dot never taken for a name. */
export function unresolvedNames(source: string) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    .replace(/@(?:builtin|interpolate|diagnostic)\s*\([^()]*\)|@\w+/g, '')
    .replace(/(\bstruct\s+\w+\s*\{)([^}]*)\}/g, (_, head: string, body: string) => {
      return `${head}${body.replace(/\w+\s*:/g, ':')}}`;
    })
    .replace(/\b(case\b[^:{]*|default\s*):/g, '$1');
  const declared = declaredNames(code);
  const used = new Set([...code.matchAll(/(?<![\w.])([A-Za-z_]\w*)/g)].map((m) => m[1]));
  return [...used].filter((name) => !declared.has(name) && !WGSL_OWN.has(name)).sort();
}
