/**
 * What each family of `ENGINE_ERROR_CODES` means, by its first code: printed under `EngineError`
 * by the API reference (`docs.ts`). The engine ships the codes alone.
 */
export const ENGINE_ERROR_MEANINGS: Readonly<Record<string, string>> = {
  CANVAS_NOT_FOUND: 'The world has no canvas to draw into: none found, or no page around it.',
  INVALID_CANVAS_LAYOUT: 'The canvas has no usable size or pixel ratio.',
  WEBGPU_UNAVAILABLE: 'The machine cannot draw the way asked, or cannot draw at all.',
  RESOURCE_HTTP_ERROR:
    'A file could not be fetched — asked again first when the failure may pass — or was not what it should be.',
  INVALID_POINTER: "The compiled model's pointer is broken, unfinished, or of another scope.",
  INVALID_CACHE:
    'The compiled model is damaged, too old, too new or of a format not read yet: compile it again.',
  INVALID_SCENE_TABLES:
    "The model's scene tables are missing, of another version, or do not lay out the scene it draws.",
  AUTONOMOUS_SCENE_UNAVAILABLE: "The engine's own WebGL2 path cannot draw this model.",
  PAGE_BUDGET:
    'The pages the view needs do not fit the memory budget, or this path has no budgets.',
  INVALID_SCENE_LIGHT: 'A light is malformed, doubled, unknown, or has nowhere to go.',
  INVALID_MATERIAL:
    'A material change is unknown, out of range, would move it to another draw class, or would tile a map it shares.',
  INVALID_SCENE_ENVIRONMENT: "The scene's exposure or surroundings are not valid numbers.",
  INVALID_TRANSFORM:
    "A node's placement is not a usable matrix, or a node would be its own ancestor.",
  UNKNOWN_SCENE_NODE:
    'A scene node is unknown, gone, badly named, or given a visibility that is not yes or no.',
  SCENE_ROOT_PARENT:
    'Something the scene root forbids: a parent for it, destroying it, mixing two roots, copying a node into itself.',
  UNSUPPORTED_SCENE_UPDATE: 'This drawing path cannot make that change to the scene.',
  RAYCAST_NO_VIEW:
    'A picture point was asked of a canvas with no size: there is no picture to aim through.',
  WEBGPU_LOST:
    'WebGPU lost its device, or an error on it left a state nothing can draw from: thrown by `render`, `flush` and the reads that need the device, named by the `gpu-device-lost` diagnostic, and on `world.diagnostic.error` when a session could not open for it.',
  SESSION_OPEN_FAILED:
    "The world's session could not open, for a reason with no code of its own (`world.diagnostic.error`): the error thrown is in `details.cause`.",
  UNSUPPORTED_SCENE_FORMAT:
    'A saved scene is of another format or version, or holds what a saved scene cannot store.',
  PHYSICS_BUDGET:
    "The physics was asked past one of its envelopes (`world.budget.physics`: bodies, decorative bodies, memory, body pairs and contacts per step), or a dynamic body was not a direct child of the scene (`PHYSICS_NESTED`), or the physics module failed or refused a body's shape (`PHYSICS_FAILED`): on `world.physics.error`.",
  PHYSICS_FORMAT:
    "A compiled model's cooked physics (`physics.json`) is of another format, or was cooked by another Jolt than the engine's (`PHYSICS_FORMAT`): compile it again. An exact raycast was asked with the physics off (`PHYSICS_OFF`).",
  NO_VEHICLE:
    "`world.controls.kind` was set to `'vehicle'` while `world.controls.vehicle` is `null`: there is nothing to drive.",
  GUIDE_CEILING:
    'A `world.guides` call would hold more vertices than `GUIDE_VERTEX_CEILING`; nothing of it was added.',
};
