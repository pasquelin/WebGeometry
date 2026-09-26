import { SCENE_LIGHT_FLOATS, SCENE_LIGHT_HEADER_FLOATS } from '../light/contracts.ts';
import { LIGHT_FIELD, type SceneLightStore } from '../light/store.ts';

/** First float of light `slot` in the packed store. */
export const baseOf = (slot: number) => SCENE_LIGHT_HEADER_FLOATS + slot * SCENE_LIGHT_FLOATS;

/** True when the light at `slot` declares a shadow, whether or not it holds a slice yet. */
export const castsShadow = (store: SceneLightStore, slot: number) =>
  store.packed[baseOf(slot) + LIGHT_FIELD.castsShadow] !== 0;

/** Lights of the store that declare a shadow: what a shadow pool is for (`shadowPoolSize`). */
export function shadowCasterLights(store: SceneLightStore) {
  let lights = 0;
  for (let slot = 0; slot < store.count; slot++) if (castsShadow(store, slot)) lights++;
  return lights;
}
