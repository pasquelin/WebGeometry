import { EngineError } from '../../contracts/cache.ts';
import { grown } from '../../math/transform-tree/transformTree.ts';
import {
  LIGHT_SETTINGS,
  SCENE_LIGHT_HEADER_FLOATS,
  type SceneEnvironment,
  type SceneLight,
  type SceneLightingView,
} from './contracts.ts';
import { sameSceneEnvironment, sameSceneLight } from './equal.ts';
import { SCENE_ENVIRONMENT_FLOATS, packEnvironment } from '../core/environment.ts';
import { LIGHT_FIELD, baseOf, writeLightFields } from './fields.ts';
import { validateSceneEnvironment, validateSceneLight } from './validate.ts';

export { LIGHT_FIELD } from './fields.ts';

/** The lights of a scene as the GPU reads them, packed and kept up to date. */
export type SceneLightStore = ReturnType<typeof createSceneLightStore>;

/**
 * Scene lights, as many as the scene declares: `capacity` slots, doubled when full and
 * never shrunk. Adding, setting or removing a light writes its floats and bumps its `revision`,
 * which tells a reader it changed: nothing is rebuilt per frame. The shadow scheduler reads the
 * light's shape itself, so an intensity or colour change stales no shadow page.
 */
export function createSceneLightStore() {
  let capacity = 0,
    packed = new Float32Array(0),
    header: Uint32Array,
    revision = new Uint32Array(0);
  const ids: string[] = [];
  const indexOf = new Map<string, number>();
  /** The environment's irradiance as the GPU reads it, behind the lights (`../core/environment.ts`). */
  const environmentPacked = new Float32Array(SCENE_ENVIRONMENT_FLOATS);
  let environment: SceneEnvironment | undefined,
    view: SceneLightingView = 'auto',
    epoch = 1,
    fogOnly = 0;
  /** Twice the room, content kept: N lights cost log N copies. */
  const grow = () => {
    capacity = Math.max(capacity * 2, 32);
    packed = grown(packed, Float32Array, baseOf(capacity));
    header = new Uint32Array(packed.buffer, 0, SCENE_LIGHT_HEADER_FLOATS);
    revision = grown(revision, Uint32Array, capacity);
  };
  grow();
  /** A light's atlas slice lives in the buffer itself: it is not held twice. */
  const sliceOf = (slot: number) => packed[baseOf(slot) + LIGHT_FIELD.shadowSlice];
  const writeSlice = (slot: number, slice: number) => {
    packed[baseOf(slot) + LIGHT_FIELD.shadowSlice] = slice;
  };
  /** Fields declared by the host. The shadow slice is not one: the scheduler sets it. */
  const write = (slot: number, light: SceneLight) => writeLightFields(packed, baseOf(slot), light);
  const records = new Map<string, SceneLight>();
  const store = {
    settings: LIGHT_SETTINGS,
    /** Every light, packed for the GPU: a new array when the table grows. */
    get packed() {
      return packed;
    },
    environmentPacked,
    /** Bumped on every change, per slot. */
    get revision() {
      return revision;
    },
    /** Slots the table holds: the GPU light buffer is this long. */
    get capacity() {
      return capacity;
    },
    sliceOf,
    /** Each slot's light name. */
    ids,
    /** How many lights. */
    get count() {
      return ids.length;
    },
    /** Bumped when the set of lights changes. */
    get epoch() {
      return epoch;
    },
    /** Bumped with the epoch, except by a change of the fog alone: fog is a view-ray term, not
     *  light transport, so what caches transported light (the bounce probes) keeps it. */
    get transportEpoch() {
      return epoch - fogOnly;
    },
    /** The scene's environment. */
    get environment() {
      return environment;
    },
    /** View requested by the host, as-is: `auto` as long as it has asked for nothing. */
    get lightingView(): SceneLightingView {
      return view;
    },
    /**
     * True when the image must come out as raw albedo, with no light. This is the default
     * behaviour as long as no light is declared: a scene without a source has nothing to light, and a
     * black image would help no geometry bench. As soon as a light exists, real lighting
     * takes over — unless the host has explicitly asked for the diagnostic view.
     */
    get unlit() {
      return view === 'unlit' || (view === 'auto' && ids.length === 0);
    },
    /** Sets what the host asks to see. */
    setView(next: SceneLightingView) {
      if (view === next) return;
      view = next;
      epoch++;
    },
    /** The held record, the store's own: engines read it on the frame path and copy nothing.
     *  Not for the host — the public API hands out `cloneSceneLight` copies. */
    light(id: string) {
      return records.get(id);
    },
    /** The slot of a light. */
    slotOf(id: string) {
      return indexOf.get(id) ?? -1;
    },
    /** Adds a light. */
    add(light: SceneLight) {
      const validated = validateSceneLight(light);
      if (indexOf.has(validated.id))
        throw new EngineError('DUPLICATE_SCENE_LIGHT', `light ${validated.id} already present`, {
          id: validated.id,
        });
      const slot = ids.length;
      if (slot >= capacity) grow();
      ids.push(validated.id);
      indexOf.set(validated.id, slot);
      records.set(validated.id, validated);
      revision[slot]++;
      write(slot, validated);
      // A new slot is zero in the buffer; without a slice, the published value is −1.
      writeSlice(slot, -1);
      header[0] = ids.length;
      epoch++;
      return slot;
    },
    /** Changes a light. */
    set(id: string, patch: Partial<Omit<SceneLight, 'id'>>) {
      const slot = indexOf.get(id);
      const current = records.get(id);
      if (slot === undefined || !current)
        throw new EngineError('UNKNOWN_SCENE_LIGHT', `unknown light ${id}`, { id });
      const merged = validateSceneLight({ ...current, ...patch, id });
      // A light reset identically is not a change: neither its revision nor the epoch
      // move, so the scheduler stales no shadow page and the held frame stays.
      if (sameSceneLight(current, merged)) return;
      records.set(id, merged);
      revision[slot]++;
      write(slot, merged);
      epoch++;
    },
    /** Removes a light. */
    remove(id: string) {
      const slot = indexOf.get(id);
      if (slot === undefined)
        throw new EngineError('UNKNOWN_SCENE_LIGHT', `unknown light ${id}`, { id });
      const last = ids.length - 1;
      if (slot !== last) {
        const movedId = ids[last];
        ids[slot] = movedId;
        indexOf.set(movedId, slot);
        revision[slot] = revision[last] + 1;
        write(slot, records.get(movedId)!);
        writeSlice(slot, sliceOf(last));
      }
      ids.length = last;
      indexOf.delete(id);
      records.delete(id);
      revision[last] = 0;
      packed.fill(0, baseOf(last), baseOf(last + 1));
      header[0] = ids.length;
      epoch++;
    },
    /** Sets the environment. */
    setEnvironment(next: SceneEnvironment) {
      const validated = validateSceneEnvironment(next);
      // Same rule as `set`: an exposure reset as-is does not stale the frame.
      if (environment && sameSceneEnvironment(environment, validated)) return;
      if (
        environment &&
        sameSceneEnvironment({ ...environment, fog: undefined }, { ...validated, fog: undefined })
      )
        fogOnly++;
      environment = validated;
      packEnvironment(environment, environmentPacked);
      epoch++;
    },
    /** Records the atlas slice a light occupies, without touching the rest of its fields. The store
     *  revision only rises if the slice actually changed: otherwise nothing is pushed to the GPU. */
    assignSlice(slot: number, slice: number) {
      if (sliceOf(slot) === slice) return;
      writeSlice(slot, slice);
      epoch++;
    },
  };
  return store;
}
