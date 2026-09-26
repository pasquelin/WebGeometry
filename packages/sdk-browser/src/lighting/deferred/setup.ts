import { SHADOW_ARRAY, arrayView } from '../../gpu/shadow/layers.ts';
import {
  MAX_SHADOW_SLICES,
  PROBE_FLOATS,
  SHADOW_RECORD_FLOATS,
} from '../../../../sdk-core/src/index.ts';
import { CONTRACT_SHADOW_BINDINGS } from '../direct/lightingWgsl.ts';
import { BOUNCE_GRID_BYTES } from '../../bounce/uniform.ts';
import { PROXY_HEADER_BYTES } from '../../bounce/nodeWgsl.ts';
import { SUN_FAR_PROXY_BINDING } from '../../gpu/shadow/sunFarShadowWgsl.ts';
import { DEPTH_COMPARE } from '../../camera/depthConvention.ts';
import { BOUNCE_SURFACE_BINDING } from '../../bounce/reflectWgsl.ts';
import { SHADOW_TRANSMITTANCE_FORMAT } from '../../gpu/shadow/transmittance.ts';

/**
 * Substitute of the resident proxy: a header of zeros and four words behind it. Presence
 * is zero there, node count too, so no distant-shadow ray is fired and the distant surface
 * stays lit exactly as before that ray existed.
 */
const PLACEHOLDER_PROXY_BYTES = PROXY_HEADER_BYTES + 16;

/**
 * Bindings of the deferred pass. The unlit view stops at the surfaces and the uniform;
 * the contract program adds the declared lights, their per-tile lists, their shadow slices
 * and the atlas; the bounce one adds the probe grid. None of the three reads a light written
 * in the scene: there is none left. The water composite extends the full list with its own
 * bindings, so a surface lit there is read on the same numbers.
 */
export function deferredLayoutEntries(
  direct: boolean,
  bounce = false,
  proxy: GPUBufferBindingLayout = { type: 'storage' },
  marks = true,
) {
  const entries: GPUBindGroupLayoutEntry[] = [0, 1, 2, 3, 4].map((binding) => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: {
      sampleType: binding === 3 ? 'uint' : binding === 4 ? 'depth' : 'unfilterable-float',
    },
  }));
  entries.push({ binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } });
  if (direct)
    entries.push(
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: SHADOW_ARRAY },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      // Resident proxy of the sun's distant shadow: a single binding, which carries both
      // the columns a ray traverses, that ray's settings and the two counters of the
      // counted frame. That is what lets the blend pass bind it too. Writable here, where the
      // counters are written; the water composite, which only traces, declares it read-only.
      { binding: SUN_FAR_PROXY_BINDING, visibility: GPUShaderStage.FRAGMENT, buffer: proxy },
      {
        binding: CONTRACT_SHADOW_BINDINGS.transmittance,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d-array' },
      },
      {
        binding: CONTRACT_SHADOW_BINDINGS.translucentDepth,
        visibility: GPUShaderStage.FRAGMENT,
        texture: SHADOW_ARRAY,
      },
    );
  // The shadow pages the resolve reads, recorded for the scheduler: only the opaque resolve asks.
  if (direct && marks)
    entries.push({
      binding: CONTRACT_SHADOW_BINDINGS.requests,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: 'storage' },
    });
  // Probe grid, their coefficients and the surface cache a reflection reads: bound only by the
  // bounce program, so a session without bounce keeps exactly the previous layout.
  if (bounce)
    entries.push(
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 12, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      {
        binding: BOUNCE_SURFACE_BINDING,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      },
    );
  return entries;
}

export function createDeferredLayouts(device: GPUDevice, direct: boolean, bounce = false) {
  const fragment = GPUShaderStage.FRAGMENT;
  const composition = (share: GPUTextureSampleType) =>
    device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: fragment, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: fragment, buffer: { type: 'uniform' } },
        { binding: 2, visibility: fragment, texture: { sampleType: share } },
      ],
    });
  return {
    lighting: device.createBindGroupLayout({ entries: deferredLayoutEntries(direct, bounce) }),
    composition: { still: composition('uint'), accumulated: composition('unfilterable-float') },
  };
}

/**
 * Contract substitute resources: an empty tile list, shadow records with no light and an empty
 * page table, a request buffer nothing reads, a one-texel pool (the translucent depth too) and
 * transmittance layer, a probe grid at zero and an empty surface cache. A device that refuses
 * the real atlas keeps valid bindings, the light simply unshadowed; a frame without bounce reads
 * zero probes, hence zero indirect light. The blend pass borrows the same substitutes.
 */
export function createDeferredPlaceholders(device: GPUDevice) {
  const tiles = device.createBuffer({
    label: 'Trillion3D empty light tiles',
    size: 256,
    usage: GPUBufferUsage.STORAGE,
  });
  const slices = device.createBuffer({
    label: 'Trillion3D empty shadow records',
    // One table word, rounded up to the struct's 16-byte alignment: WGSL sizes `ShadowData` so,
    // and a binding four bytes short invalidates every pass that reads it.
    size: MAX_SHADOW_SLICES * SHADOW_RECORD_FLOATS * 4 + 16,
    usage: GPUBufferUsage.STORAGE,
  });
  // One word: bound only beside the empty records, which name no light, it is never written.
  const requests = device.createBuffer({
    label: 'Trillion3D unread shadow requests',
    size: 4,
    usage: GPUBufferUsage.STORAGE,
  });
  const atlas = device.createTexture({
    label: 'Trillion3D empty shadow atlas',
    size: [1, 1, 1],
    format: 'depth32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  // One texel: the shadow read tells it from a real layer by its size, and never reads it.
  const transmittance = device.createTexture({
    label: 'Trillion3D empty shadow transmittance',
    size: [1, 1, 1],
    format: SHADOW_TRANSMITTANCE_FORMAT,
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  // Shadow-atlas comparison is the engine's: reversed depth, hence `greater`.
  const sampler = device.createSampler({
    label: 'Trillion3D shadow comparison',
    compare: DEPTH_COMPARE,
    magFilter: 'linear',
    minFilter: 'linear',
  });
  // The substitute carries the size of `BounceGrid`, read where the struct is written: a binding
  // smaller than what the shader declares is refused by validation, and the device is lost.
  // At zero, the probe count is too and `sampleBounce` returns without reading a coefficient;
  // the probe buffer holds a whole probe, so its size also follows the struct.
  const bounceGrid = device.createBuffer({
    label: 'Trillion3D empty bounce grid',
    size: BOUNCE_GRID_BYTES,
    usage: GPUBufferUsage.UNIFORM,
  });
  const probes = device.createBuffer({
    label: 'Trillion3D empty bounce probes',
    size: PROBE_FLOATS * 4,
    usage: GPUBufferUsage.STORAGE,
  });
  // One texel of zero: the water composite binds it while bounce is off, and reads none.
  const surfaceCache = device.createBuffer({
    label: 'Trillion3D empty bounce surface cache',
    size: 16,
    usage: GPUBufferUsage.STORAGE,
  });
  // The absent proxy: a header of zeros, which the shader reads as a tree with no node and as
  // an absent distant shadow. Both lighting passes bind the same one, so a session without
  // proxy renders exactly the same image on opaque and on blend.
  const proxy = device.createBuffer({
    label: 'Trillion3D empty resident proxy',
    size: PLACEHOLDER_PROXY_BYTES,
    usage: GPUBufferUsage.STORAGE,
  });
  return {
    tiles,
    slices,
    requests,
    atlasView: arrayView(atlas),
    transmittanceView: arrayView(transmittance),
    sampler,
    bounceGrid,
    probes,
    surfaceCache,
    proxy,
    dispose() {
      tiles.destroy();
      slices.destroy();
      requests.destroy();
      atlas.destroy();
      transmittance.destroy();
      bounceGrid.destroy();
      probes.destroy();
      surfaceCache.destroy();
      proxy.destroy();
    },
  };
}
