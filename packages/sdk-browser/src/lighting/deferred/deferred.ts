import type { SurfaceBuffer } from '../../scene/surfaceBuffer.ts';
import {
  BOUNCE_LIGHTING_SHADER,
  COMPOSE_SHADERS,
  DIRECT_LIGHTING_SHADER,
  UNLIT_COMPOSE_SHADERS,
  UNLIT_LIGHTING_SHADER,
} from './shaders.ts';
import { createDeferredPlaceholders } from './setup.ts';
import {
  createDeferredProgram,
  type ComposedImage,
  type DeferredProgram,
  type DirectLightResources,
} from './program.ts';
import { ZERO_DIRECT, createDeferredView } from './view.ts';
export { DIRECT_LIGHTING_SHADER, FULLSCREEN_VERTEX } from './shaders.ts';

/** Label of the measured pass; `gpuLightingMs` is read under this name. */
export const DEFERRED_LIGHTING_PASS = 'Trillion3D deferred lighting';

/**
 * Deferred resolve. Two programs live here: the unlit view — raw material albedo, composed
 * by identity, which is also what a scene with no declared light renders — and the contract
 * one, exposed then passed through ACES. The second is compiled only on the first frame that
 * carries a light: a scene that has none never pays for it.
 *
 * `onReady` is called on every arrival of a contract program, DIRECT as BOUNCE. That is the
 * only announcement of this frame change: compilation finishes between two frames, without
 * the caller having asked for anything, and the next frame would still render raw albedo if
 * no one said so. A program that arrives while its variant is no longer wanted causes one
 * more frame to be redone, never a wrong frame.
 */
export async function createDeferredLighting(device: GPUDevice, onReady?: () => void) {
  const view = createDeferredView(device);
  const uniform = view.buffer;
  const placeholders = createDeferredPlaceholders(device);
  const bindings = { uniform, placeholders };
  try {
    const unlit = await createDeferredProgram(
      device,
      // The unlit view composes by identity: with no declared source, no radiance is to be
      // exposed or brought into the display range, and albedo must be read as-is (P6).
      {
        lighting: UNLIT_LIGHTING_SHADER,
        compose: UNLIT_COMPOSE_SHADERS,
        label: 'UNLIT',
        direct: false,
      },
      bindings,
    );
    // Three programs, never a branch: the unlit view, the contract, and the contract plus
    // bounce. A session without bounce thus runs exactly the previous shader.
    type Variant = { program?: DeferredProgram; pending?: Promise<unknown> };
    const variants: Record<'direct' | 'bounce', Variant> = { direct: {}, bounce: {} };
    let active: DeferredProgram = unlit;
    // Diagnostic views output raw values: no ACES, no sRGB, no composed background. The
    // indirect-irradiance view is one, and lighting says so, not the caller.
    let rawOutput = false;
    return {
      uniform,
      /** What an absent contract resource is worth: the blend pass binds the same. */
      placeholders,
      /** Outputs the image in raw values, without the display chain. For a measurement view. */
      setRawOutput(value: boolean) {
        rawOutput = value;
      },
      /** True when the current frame is rendered by a contract program. */
      get usesContract() {
        return active !== unlit;
      },
      /** Writes the view uniform of this image (`view.ts`). */
      update(
        inverseViewProjection: ArrayLike<number>,
        camera: readonly number[],
        width: number,
        height: number,
        clearColor: number,
        diagnostic: boolean,
        direct: ArrayLike<number> = ZERO_DIRECT,
        sampledRank = 0,
      ) {
        const raw = diagnostic || rawOutput;
        view.write(
          inverseViewProjection,
          camera,
          width,
          height,
          clearColor,
          raw,
          direct,
          sampledRank,
        );
      },
      /**
       * Picks the frame program and binds its resources. `wantsContract` stays false as long as
       * the host has declared no light, or as long as it asks for the unlit view; compilation
       * of the contract program is started on the first request and the unlit view stays
       * correct while it finishes.
       */
      bind(
        surface: SurfaceBuffer,
        depth: GPUTextureView,
        hdr: GPUTextureView,
        wantsContract: boolean,
        direct: DirectLightResources = {},
        onFailure?: (error: unknown) => void,
      ) {
        const wantsBounce = wantsContract && !!direct.bounceGrid && !!direct.probes;
        const variant = variants[wantsBounce ? 'bounce' : 'direct'];
        if (wantsContract && !variant.program && !variant.pending)
          variant.pending = createDeferredProgram(
            device,
            {
              lighting: wantsBounce ? BOUNCE_LIGHTING_SHADER : DIRECT_LIGHTING_SHADER,
              compose: COMPOSE_SHADERS,
              label: wantsBounce ? 'BOUNCE' : 'DIRECT',
              direct: true,
              bounce: wantsBounce,
            },
            bindings,
          ).then(
            (program) => {
              variant.program = program;
              onReady?.();
            },
            (error) => onFailure?.(error),
          );
        // The bounce program takes a frame or two to compile: the contract one renders
        // the frame while waiting, without bounce, rather than make the frame wait.
        active =
          (wantsContract ? (variant.program ?? variants.direct.program) : undefined) ?? unlit;
        active.bind(surface, depth, hdr, direct);
      },
      /** Waits for in-flight contract-program compiles, when there are any. */
      settle() {
        return Promise.all([variants.direct.pending, variants.bounce.pending]).then(() => {});
      },
      light(encoder: GPUCommandEncoder, target: GPUTextureView) {
        const group = active.lightGroup;
        if (!group) throw new Error('SURFACE_NOT_BOUND');
        const pass = encoder.beginRenderPass({
          label: DEFERRED_LIGHTING_PASS,
          colorAttachments: [
            { view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
          ],
        });
        pass.setPipeline(active.light);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
      },
      /** Composes the lit image, or `composed`: the temporal output, or the effect chain's. */
      compose(
        encoder: GPUCommandEncoder,
        target: GPUTextureView,
        clear: GPUColor,
        presentation?: GPUTextureView,
        composed?: ComposedImage,
      ) {
        const composition = active.composition(composed);
        if (!composition) throw new Error('SURFACE_NOT_BOUND');
        const colorAttachments: GPURenderPassColorAttachment[] = [
          { view: target, loadOp: 'clear', storeOp: 'store', clearValue: clear },
        ];
        if (presentation) colorAttachments.push({ ...colorAttachments[0], view: presentation });
        const pass = encoder.beginRenderPass({
          label: presentation
            ? 'Trillion3D HDR composition + present'
            : 'Trillion3D HDR composition',
          colorAttachments,
        });
        pass.setPipeline(presentation ? composition.present : composition.draw);
        pass.setBindGroup(0, composition.group);
        pass.draw(3);
        pass.end();
      },
      dispose() {
        view.dispose();
        placeholders.dispose();
        unlit.release();
        variants.direct.program?.release();
        variants.bounce.program?.release();
      },
    };
  } catch (error) {
    view.dispose();
    placeholders.dispose();
    throw error;
  }
}
