// Set dressing of the dispatch measurement: the measured scene and the command count an
// encode opens. Split from the page so each of the two keeps its responsibility.
import * as G from '../../../packages/sdk-browser/src/host/graph/graph.fixture.ts';
import {
  packDagSelection,
  packedWorldsToRenderOrigin,
} from '../../../packages/sdk-browser/src/gpu/dag/pack.ts';
import { cameraSelectionUniforms } from '../../../packages/sdk-browser/src/gpu/core/selection.ts';
import { cameraMoteur } from '../../../packages/sdk-browser/src/camera/camera.fixture.ts';
import { uploadResidency } from '../../../packages/sdk-browser/src/gpu/dag/readiness.fixture.ts';
import {
  scenePages,
  sceneRoots,
} from '../../../packages/sdk-browser/src/gpu/dag/cutFrontierScene.fixture.ts';

/** The scene: a pyramid of levels, one pose, every page resident, front view. The hierarchy is
 *  the compiler's, one node per detail tier under the root. Residency goes through the engine's
 *  own upload: both bit sets of the cut rule and each node's open count (#486). Setting the ready
 *  bits alone says every finer group is missing, and the rule then draws each coarse page a
 *  descent keeps, so the cut drawn depends on the descent the bench is comparing. */
export function scene(feuilles: number, niveaux: number) {
  const roots = sceneRoots(scenePages(feuilles, niveaux), [new G.Matrix4()], true);
  const packed = packDagSelection(roots);
  uploadResidency(packed, new Uint8Array(packed.pageCount).fill(1));
  return { packed, roots };
}

/** The dispatch bench's view of the scene: its camera, and the worlds brought back to that
 *  camera's render origin. */
export function sceneView(feuilles: number, niveaux: number) {
  const { packed, roots } = scene(feuilles, niveaux);
  const camera = G.perspectiveCamera(55, 16 / 9, 0.1, 200);
  camera.position.set(0, 0, 16);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const uniforms = cameraSelectionUniforms(cameraMoteur(camera), 1, [1280, 720]);
  packedWorldsToRenderOrigin(packed, roots, uniforms.cameraWorld);
  return { packed, uniforms };
}

/**
 * Commands an encode actually opens, counted on an encoder that only notes them.
 * Published, never asserted here: the command-count contract is held by
 * `packages/sdk-browser/src/gpu/dag/encode.test.ts`, which counts the same encoder without mounting a device.
 */
const RIEN = () => {};
export function commandes(encode: (encoder: GPUCommandEncoder) => void): {
  passes: number;
  copies: number;
} {
  let passes = 0,
    copies = 0;
  const passe = {
    setBindGroup: RIEN,
    setPipeline: RIEN,
    end: RIEN,
    dispatchWorkgroups: RIEN,
    dispatchWorkgroupsIndirect: RIEN,
  };
  // A minimal counting double: `encodeDagKernels`/`encodeAvant` only ever call the methods
  // named here, never mount a real device — the full `GPUCommandEncoder` surface is unneeded.
  const encoder = {
    beginComputePass: () => (passes++, passe),
    copyBufferToBuffer: () => copies++,
  } as unknown as GPUCommandEncoder;
  encode(encoder);
  return { passes, copies };
}
