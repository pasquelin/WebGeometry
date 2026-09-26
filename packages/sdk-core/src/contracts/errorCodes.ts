import { EngineError } from './cache.ts';

/**
 * Every code an `EngineError` may carry, by family: the words a page may test. What each family
 * means is for the API reference alone (`scripts/api-reference/errorCodeMeanings.ts`).
 */
export const ENGINE_ERROR_CODES: readonly (readonly string[])[] = [
  [
    'CANVAS_NOT_FOUND',
    'CANVAS_DOCUMENT_UNAVAILABLE',
    'CANVAS_WINDOW_UNAVAILABLE',
    'INVALID_CANVAS',
  ],
  ['INVALID_CANVAS_LAYOUT', 'INVALID_VIEWPORT', 'INVALID_PIXEL_RATIO'],
  ['WEBGPU_UNAVAILABLE', 'WEBGL2_UNAVAILABLE', 'NO_WEBGL2', 'NO_ENGINE_BACKEND'],
  ['RESOURCE_HTTP_ERROR', 'INVALID_JSON_RESPONSE'],
  ['INVALID_POINTER', 'CACHE_NOT_READY', 'SCOPE_MISMATCH'],
  ['INVALID_CACHE', 'UNSUPPORTED_FORMAT', 'STALE_CACHE', 'UNSUPPORTED_MODEL_FORMAT'],
  ['INVALID_SCENE_TABLES', 'UNSUPPORTED_SCENE_TABLES', 'PREPARED_SCENE_MISMATCH'],
  [
    'AUTONOMOUS_SCENE_UNAVAILABLE',
    'AUTONOMOUS_ASSOCIATION_MISSING',
    'AUTONOMOUS_COVERAGE_MISSING',
    'CLUSTER_MATERIAL_UNSUPPORTED',
  ],
  ['PAGE_BUDGET', 'UNSUPPORTED_MEMORY_BUDGETS'],
  [
    'INVALID_SCENE_LIGHT',
    'DUPLICATE_SCENE_LIGHT',
    'UNKNOWN_SCENE_LIGHT',
    'SCENE_LIGHT_BUDGET',
    'SCENE_LIGHTS_UNAVAILABLE',
  ],
  ['INVALID_SCENE_ENVIRONMENT'],
  ['INVALID_MATERIAL', 'UNKNOWN_MATERIAL', 'MATERIAL_CLASS_CHANGE', 'MATERIAL_TEXTURE_SHARED'],
  ['INVALID_TRANSFORM', 'NON_FINITE_TRANSFORM', 'SINGULAR_PARENT_TRANSFORM', 'TRANSFORM_CYCLE'],
  [
    'UNKNOWN_SCENE_NODE',
    'UNKNOWN_TRANSFORM_NODE',
    'STALE_SCENE_NODE',
    'INVALID_SCENE_NODE_ID',
    'DUPLICATE_SCENE_NODE_ID',
    'INVALID_SCENE_NODE_VISIBILITY',
  ],
  ['SCENE_ROOT_PARENT', 'SCENE_ROOT_DESTROY', 'SCENE_ROOT_MISMATCH', 'SCENE_COPY_OVERLAP'],
  ['UNSUPPORTED_SCENE_UPDATE', 'BATCHED_WORLD_VIEW'],
  ['RAYCAST_NO_VIEW'],
  ['WEBGPU_LOST'],
  ['SESSION_OPEN_FAILED'],
  ['UNSUPPORTED_SCENE_FORMAT', 'SCENE_NOT_SAVABLE'],
  ['PHYSICS_BUDGET', 'PHYSICS_NESTED', 'PHYSICS_FAILED'],
  ['PHYSICS_FORMAT', 'PHYSICS_OFF'],
  ['NO_VEHICLE'],
  ['GUIDE_CEILING'],
];

const documented: ReadonlySet<string> = new Set(ENGINE_ERROR_CODES.flat());

/** An object as text, never `[object Object]`: its JSON, or its kind when JSON refuses it. */
function textOf(cause: unknown) {
  if (typeof cause !== 'object' || cause === null) return String(cause);
  try {
    return JSON.stringify(cause) ?? typeof cause;
  } catch {
    return `${cause.constructor?.name ?? 'Object'} (cannot be written out)`;
  }
}

/**
 * `cause` as a named engine error. An `EngineError` of a documented code as it is — one of
 * another copy of the engine (same `name` and `code`) as this copy's. Anything else under the
 * documented code it carries in `code`, else in its whole message (the bare
 * `new Error('WEBGPU_LOST')` of the renderers; an engine error's message is prose), else under
 * `fallback`; the error thrown is kept in `details.cause`.
 */
export function engineErrorOf(cause: unknown, fallback: string, message: string): EngineError {
  const { name, code, details, message: said } = Object(cause) as Partial<EngineError>;
  const known = typeof code === 'string' && documented.has(code) ? code : undefined;
  const engine =
    cause instanceof EngineError || (name === 'EngineError' && typeof code === 'string');
  if (engine && known)
    return cause instanceof EngineError
      ? cause
      : new EngineError(known, String(said), { ...details, cause });
  const words =
    cause instanceof Error
      ? cause.message
      : (known ??
        (typeof said === 'string' ? said : typeof code === 'string' ? code : textOf(cause)));
  const named = known ?? (!engine && documented.has(words) ? words : fallback);
  return new EngineError(named, `${message}: ${words}`, { cause });
}
