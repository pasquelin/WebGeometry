/**
 * What the autonomous WebGL2 program draws of a physical material: the glTF transmission
 * volume — `KHR_materials_transmission`, `KHR_materials_ior`, `KHR_materials_volume` as
 * factors — and nothing else. Every other physical extension is named here before a draw: the
 * surface is drawn without it and the world says so by name (`noticeMaterialDegraded`), so a
 * surface never loses a declared feature silently and never stops the loop.
 */
import type { HostShadedMaterial } from '../host/shadedMaterial.ts';

/** The physical material as this gate reads it: what `../host/shadedMaterial.ts` already declares of
 *  a shaded surface, plus the extension slots only a refusal ever looks at. Declared here and not
 *  there because nothing else in the engine reads them — they exist to be named in a refusal. */
type PhysicalLike = HostShadedMaterial & {
  readonly transmissionMap?: unknown;
  readonly thicknessMap?: unknown;
  readonly clearcoat?: number;
  readonly clearcoatMap?: unknown;
  readonly clearcoatRoughnessMap?: unknown;
  readonly clearcoatNormalMap?: unknown;
  readonly sheen?: number;
  readonly sheenColorMap?: unknown;
  readonly sheenRoughnessMap?: unknown;
  readonly iridescence?: number;
  readonly iridescenceMap?: unknown;
  readonly iridescenceThicknessMap?: unknown;
  readonly anisotropy?: number;
  readonly anisotropyMap?: unknown;
  readonly dispersion?: number;
  readonly specularIntensity?: number;
  readonly specularIntensityMap?: unknown;
  readonly specularColorMap?: unknown;
  readonly specularColor?: { readonly r: number; readonly g: number; readonly b: number };
};

const EXTENSION_FACTORS = [
  'clearcoat',
  'sheen',
  'iridescence',
  'anisotropy',
  'dispersion',
] as const;
const EXTENSION_MAPS = [
  'transmissionMap',
  'thicknessMap',
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'anisotropyMap',
  'specularIntensityMap',
  'specularColorMap',
] as const;

/** Names every physical extension a material declares beyond the transmission volume, none
 *  when it declares none. The IOR shapes the Fresnel of the transmission pass alone: without
 *  transmission, the cluster BRDF keeps its dielectric F0, so the declared IOR is one of them. */
export function physicalFeaturesLost(material: PhysicalLike) {
  if (material.family !== 'physical') return;
  const lost: string[] = [];
  if ((material.ior ?? 1.5) !== 1.5 && !((material.transmission ?? 0) > 0)) lost.push('ior');
  for (const factor of EXTENSION_FACTORS) if ((material[factor] ?? 0) !== 0) lost.push(factor);
  for (const map of EXTENSION_MAPS) if (material[map]) lost.push(map);
  const specular = material.specularColor;
  if (
    (material.specularIntensity ?? 1) !== 1 ||
    (specular && (specular.r !== 1 || specular.g !== 1 || specular.b !== 1))
  )
    lost.push('specular');
  return lost.length ? lost : undefined;
}
