import { LIGHT_FIELD, baseOf } from '../light/fields.ts';
import type { SceneLightStore } from '../light/store.ts';

/** True when the light at `slot` declares a shadow, whether or not it holds a slice yet. */
export const castsShadow = (store: SceneLightStore, slot: number) =>
  store.packed[baseOf(slot) + LIGHT_FIELD.castsShadow] !== 0;

/** Lights of the store that declare a shadow: what a shadow pool is for (`shadowPoolSize`). */
export function shadowCasterLights(store: SceneLightStore) {
  let lights = 0;
  for (let slot = 0; slot < store.count; slot++) if (castsShadow(store, slot)) lights++;
  return lights;
}
