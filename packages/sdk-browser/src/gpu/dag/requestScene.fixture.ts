import * as G from '../../host/graph/graph.fixture.ts';
import { cameraSelectionUniforms } from '../core/selection.ts';
import { cameraMoteur } from '../../camera/camera.fixture.ts';
import { packDagSelection, packedWorldsToRenderOrigin } from './selection.ts';
import { scenePages, sceneRoots } from './cutFrontierScene.fixture.ts';
import { frontCamera } from '../../page/selection/dag.fixture.ts';

/**
 * Frontier-count scene, posed at FOUR DEPTHS: a single pose keeps only one detail stage, hence
 * one band, and order would be checked on nothing. Far away, the copies resolve to different
 * stages and the cut carries several bands at once — what a real scene does all the time.
 */
export function requestScene(seuil: number, feuilles = 4096, niveaux = 8) {
  const pages = scenePages(feuilles, niveaux);
  const poses = [0, 12, 30, 70].map((z) => new G.Matrix4().makeTranslation(0, 0, -z));
  const roots = sceneRoots(pages, poses, true);
  const packed = packDagSelection(roots);
  // Posed by the scene builder that owns camera poses, read through the contract.
  const cam = cameraMoteur(frontCamera(16, 200));
  const uni = cameraSelectionUniforms(cam, seuil, [1280, 720]);
  // WebGL2 ranking reads the SAME pose: the relative view of the render frame and the poses
  // brought into it. Giving them in absolute world under a relative view would compare two frames.
  packedWorldsToRenderOrigin(packed, roots, uni.cameraWorld);
  return { pages, packed, uni, cam, roots };
}
