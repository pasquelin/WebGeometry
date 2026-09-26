import { LIGHT_FIELD, baseOf } from '../light/fields.ts';
import type { SceneLightStore } from '../light/store.ts';

/** True when the light at `slot` declares a shadow, whether or not it holds a slice yet. */
export const castsShadow = (store: SceneLightStore, slot: number) =>
  store.packed[baseOf(slot) + LIGHT_FIELD.castsShadow] !== 0;

/** True when a light of the store declares a shadow: what a shadow pool is for. */
export function anyCastsShadow(store: SceneLightStore) {
  for (let slot = 0; slot < store.count; slot++) if (castsShadow(store, slot)) return true;
  return false;
}
