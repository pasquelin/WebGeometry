/**
 * The engine record of a host texture, read in one place — here — and kept ONE per host texture:
 * atlas layers, preview ranks and lane pools address a texture by the identity of its record, so
 * the record is refilled in place by `followHostTexture`, called by each consumer on the records
 * it holds when it renders. Its three counters say what moved: `version` (the picture), `sampling`,
 * `placement` (#360, #361).
 */
import type { HostTexture } from './resources.ts';
import {
  HOST_FILTER_LINEAR_MIP_LINEAR,
  HOST_FILTER_LINEAR_MIP_NEAREST,
  HOST_FILTER_NEAREST,
  HOST_FILTER_NEAREST_MIP_LINEAR,
  HOST_FILTER_NEAREST_MIP_NEAREST,
  HOST_WRAP_CLAMP_TO_EDGE,
  HOST_WRAP_MIRRORED_REPEAT,
} from './surfaceConstants.ts';
import type { Texture, TextureFilter, WrapMode } from '../../../sdk-core/src/index.ts';
import { AFFINE } from '../../../sdk-core/src/texture/contract.ts';

/** Addressing the host declared, in the engine's words; anything else repeats, as the samplers do. */
export function importWrapMode(wrap: number): WrapMode {
  if (wrap === HOST_WRAP_CLAMP_TO_EDGE) return 'clamp';
  return wrap === HOST_WRAP_MIRRORED_REPEAT ? 'mirror' : 'repeat';
}

/** Filtering the host declared; an unknown constant reads linear, as the binders already did. */
function filterOf(filter: number): TextureFilter {
  if (filter === HOST_FILTER_NEAREST) return 'nearest';
  if (filter === HOST_FILTER_NEAREST_MIP_NEAREST) return 'nearest-mip-nearest';
  if (filter === HOST_FILTER_NEAREST_MIP_LINEAR) return 'nearest-mip-linear';
  if (filter === HOST_FILTER_LINEAR_MIP_NEAREST) return 'linear-mip-nearest';
  return filter === HOST_FILTER_LINEAR_MIP_LINEAR ? 'linear-mip-linear' : 'linear';
}

type Editable = { -readonly [K in keyof Texture]: Texture[K] };
/**
 * A record and what it was last filled from: the host's version and image, and the placement
 * its matrix was composed from (`placed`); `stale` when the host disposed of it since;
 * `followed`, the count of host writes it was last brought up at.
 */
type Imported = {
  host: HostTexture;
  record: Editable;
  hostVersion: number;
  image: unknown;
  placed: Float64Array;
  stale: boolean;
  followed: number;
};
/** Host texture writes announced since the session began. */
let hostWrites = 0;
/** Announces a write of a host texture — picture, sampler or placement. Every engine path that
 *  writes one calls it: the follows are driven by it, never by polling the hosts. */
export const hostTextureWritten = () => void hostWrites++;
/** The count of announced host writes: a consumer that saw it unchanged has nothing to follow. */
export const hostTextureWrites = () => hostWrites;
/** One record per host texture, for as long as the host keeps it: an identity table, never
 *  walked — each consumer follows the records it holds. */
const imported = new WeakMap<HostTexture, Imported>();
/** The same entries, by record: what `followHostTexture` looks a record up in. */
const byRecord = new WeakMap<Texture, Imported>();

/** Writes `value` at `i`; 1 when it moved. */
function put(into: Float64Array, i: number, value: number) {
  if (into[i] === value) return 0;
  into[i] = value;
  return 1;
}

/** Refills the record's picture fields from its host. */
function fillPicture(entry: Imported) {
  const { record, host } = entry;
  record.id = host.uuid;
  record.name = host.name;
  record.image = host.image;
  record.channel = host.channel;
  record.flipY = host.flipY;
  record.premultiplyAlpha = host.premultiplyAlpha;
  record.colorSpace = host.colorSpace === 'srgb' ? 'srgb' : 'linear';
  entry.hostVersion = host.version;
  entry.image = host.image;
}

/** Marks the record stale when its texture is given back (`graph/resource.ts`), a host write: a
 *  release runs each hook once, so the hook is set again once the record has followed it. */
const followRelease = (entry: Imported) =>
  entry.host.released.add(() => ((entry.stale = true), hostWrites++));

/** Refills the record's picture when its host's version or image moved, or the host disposed of
 *  it since — `version` moves then. */
function followPicture(entry: Imported) {
  const { host } = entry;
  if (!entry.stale && entry.hostVersion === host.version && entry.image === host.image) return;
  if (entry.stale) followRelease(entry);
  entry.stale = false;
  fillPicture(entry);
  entry.record.version++;
}

/** Refills the record's sampler fields; 1 when one moved. */
function fillSampling(record: Editable, host: HostTexture) {
  const wrapS = importWrapMode(host.wrapS),
    wrapT = importWrapMode(host.wrapT),
    magFilter = filterOf(host.magFilter),
    minFilter = filterOf(host.minFilter);
  if (
    record.wrapS === wrapS &&
    record.wrapT === wrapT &&
    record.magFilter === magFilter &&
    record.minFilter === minFilter &&
    record.anisotropy === host.anisotropy
  )
    return 0;
  Object.assign(record, { wrapS, wrapT, magFilter, minFilter, anisotropy: host.anisotropy });
  return 1;
}

/** Recomposes the host's UV matrix, which the record aliases, when a source of it moved: the
 *  seven scalars the host composes it from, or its six affine entries when the page owns it
 *  (`matrixAutoUpdate` false). No trigonometry for a texture that stays put. 1 when it moved. */
function fillPlacement(host: HostTexture, placed: Float64Array) {
  const e = host.matrix.elements;
  if (!host.matrixAutoUpdate)
    return AFFINE.reduce<number>((moved, k, i) => moved | put(placed, i, e[k]), put(placed, 6, 0));
  const { offset, repeat, center } = host;
  const moved =
    put(placed, 0, offset.x) |
    put(placed, 1, offset.y) |
    put(placed, 2, repeat.x) |
    put(placed, 3, repeat.y) |
    put(placed, 4, host.rotation) |
    put(placed, 5, center.x) |
    put(placed, 6, center.y);
  if (moved) host.updateMatrix();
  return moved;
}

/**
 * The engine record of a host texture: built once, its UV matrix composed at once — a
 * `KHR_texture_transform` is read at load (`../scene/tables.ts`) —, then brought up to its host
 * by `followHostTexture`. A held record is handed back with its picture current — a new version
 * or image read, the matrix left to the follow —, so what reads it at prepare (`tileCatalogue`)
 * or on the CPU (`../visibility/math.ts`, `../visibility/raster.ts`) reads the host's image. The
 * record ALIASES the host's UV matrix (`transform`). A host that disposes of a texture it still
 * draws keeps its record: the picture is sent again at the next follow, as the host's own
 * renderer uploads it again at its next use.
 */
export function importHostTexture(host: HostTexture): Texture {
  const held = imported.get(host);
  if (held) {
    followPicture(held);
    return held.record;
  }
  const entry: Imported = {
    host,
    record: Object.assign({} as Editable, {
      version: 0,
      sampling: 0,
      placement: 0,
      transform: host.matrix.elements,
    }),
    hostVersion: 0,
    image: undefined,
    placed: new Float64Array(7).fill(NaN),
    stale: false,
    followed: hostWrites,
  };
  fillPicture(entry);
  fillSampling(entry.record, host);
  fillPlacement(host, entry.placed);
  imported.set(host, entry);
  byRecord.set(entry.record, entry);
  followRelease(entry);
  return entry.record;
}

/**
 * Brings a record up to its host at a render of a consumer that holds it, once per announced host
 * write (`hostTextureWritten`): a new version, image or disposal, a sampler field, a placement.
 * Nothing is read in a still scene. Its three counters, monotonic, say what moved (`version`: the
 * picture, `sampling`, `placement`); each consumer compares them with the ones it last read.
 * A record that no host texture made is left as it is.
 */
export function followHostTexture(record: Texture) {
  const entry = byRecord.get(record);
  if (!entry || entry.followed === hostWrites) return;
  entry.followed = hostWrites;
  const { host, record: into } = entry;
  followPicture(entry);
  if (fillSampling(into, host)) into.sampling++;
  if (fillPlacement(host, entry.placed)) into.placement++;
}

/** Format its host declares for a record's raw texels; `undefined` for any other picture. */
export function texelFormatOf(record: Texture) {
  const host = byRecord.get(record)?.host;
  return host?.kind === 'texels' ? host.format : undefined;
}
