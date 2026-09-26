import {
  validateSceneLight,
  type SceneLight,
  type SceneLightStore,
} from '../../../sdk-core/src/index.ts';
import { unmetered, type ByteMeter } from '../cluster/byteMeter.ts';
import { optionalFile } from '../cluster/pages.ts';

/** Lights cache product, next to the neighbouring manifest. Its version is its own. */
const IMPORTED_LIGHTS_FILE = 'lights.json';
/** Where a cache keeps its lights: the one address their reader and a load's plan use. */
export const importedLightsUrl = (base: string) => new URL(IMPORTED_LIGHTS_FILE, base).href;
const IMPORTED_LIGHTS_VERSION = 1;

/** What the cache declares: the source file's light list and the count of those refused. */
type ImportedLightsFile = {
  version?: number;
  lights?: unknown;
  rejected?: Record<string, number>;
};

/**
 * Reads the lights the source file carried, converted by the compiler into the engine contract.
 * A cache compiled before this product (no file: a 404, or a 403), an unknown version or an
 * unreadable body equal zero imported lights — hence exactly the previous behaviour, `unlit` view
 * by default. A file the server refuses otherwise is refused as every cache file is (`checked`).
 */
export async function loadImportedLights(
  base: string,
  signal?: AbortSignal,
  meter: ByteMeter = unmetered,
): Promise<{ lights: SceneLight[]; rejected: Record<string, number> }> {
  const none = { lights: [], rejected: {} };
  const url = importedLightsUrl(base);
  const response = await optionalFile(url, signal);
  if (!response) return none;
  let file: ImportedLightsFile;
  try {
    file = (await meter.read(response, url).json()) as ImportedLightsFile;
  } catch {
    signal?.throwIfAborted();
    return none;
  }
  if (!file || typeof file !== 'object') return none;
  if (file.version !== IMPORTED_LIGHTS_VERSION || !Array.isArray(file.lights)) return none;
  const lights: SceneLight[] = [];
  const rejected: Record<string, number> = { ...(file.rejected ?? {}) };
  for (const candidate of file.lights) {
    // An imported light goes through the contract's published validation, `validateSceneLight`,
    // the same one the store applies to host lights: this path holds no copy of it.
    try {
      lights.push(validateSceneLight(candidate as SceneLight));
    } catch {
      rejected['light-refused-by-contract'] = (rejected['light-refused-by-contract'] ?? 0) + 1;
    }
  }
  return { lights, rejected };
}

/**
 * Declares the imported lights in the session store, at open and without the host having to do
 * anything: an imported scene arrives with its lights, every one of them — the store grows with
 * the scene (#822). Shadow comes from the flag the file carried — the runtime already caps the
 * number of maps refreshed per frame.
 */
export function declareImportedLights(store: SceneLightStore, imported: readonly SceneLight[]) {
  for (const light of imported) store.add(light);
  return imported.map((light) => light.id);
}
