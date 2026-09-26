import { cameraView, ease, glideCamera, opening } from './opening.ts';
import type { CirclingWorld, Opening, View } from './opening.ts';

/** A named part of a tour: the camera flies `seconds` to its view, then holds it `hold` seconds. */
export interface Pose extends View {
  name: string;
  seconds: number;
  hold: number;
}

/** A tour under way: an opening, and the part the camera is in. */
export interface Tour extends Opening {
  /** The pose flown to or held now; `null` once the tour has ended or the viewer took over. */
  readonly part: string | null;
}

/**
 * Flies the camera through `poses` in order, each eased by `curve` from where the last one left
 * it — the first from where the camera stands —, the same frames on every run: an opening, so the
 * viewer's first press or wheel on the canvas takes the controls, and the tour ends with its last
 * hold.
 */
export function tour(world: CirclingWorld, poses: readonly Pose[], curve = ease.inOut): Tour {
  let start: number[] = [],
    part: string | null = null;
  const glide = opening(world, (time) => {
    if (time === 0) start = cameraView(world);
    let from = start,
      at = time;
    for (const pose of poses) {
      const to = [...pose.position, ...pose.target];
      if (at < pose.seconds + pose.hold) {
        glideCamera(world, from, to, curve(pose.seconds ? at / pose.seconds : 1));
        part = pose.name;
        return true;
      }
      [from, at] = [to, at - pose.seconds - pose.hold];
    }
    return false;
  });
  return Object.defineProperties(glide, {
    part: { get: () => (glide.gliding ? part : null) },
  }) as Tour;
}
