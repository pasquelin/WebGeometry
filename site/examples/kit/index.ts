/**
 * The example kit, served beside the engine as `runtime/kit.js`: what an example page needs
 * around its render and nothing of the engine — a settings panel it declares in a few lines,
 * a corner of the frame's measured counters, a game's menu and pause while the mouse is free,
 * the point the pointer shows on the ground, a video file the viewer picks, and a seeded
 * sequence that places the same scene on every run, noise to make sounds from, and a card that
 * names the error an example stops on, and a banner at the top of the frame for the line of what
 * to do and the news the example gives (`banner.ts`). Its words, and the page's own, are read in
 * the reader's language before the example runs (`words.ts`). And the pieces several examples
 * build, made with the engine families the page hands them: vehicles to drive (`vehicles.ts`), a
 * robot and its clips (`robot.ts`), and pictures painted pixel by pixel (`painted.ts`).
 */
import { announceWhatToDo } from './banner.ts';
import { watchFailures } from './failure.ts';
import { loadWords } from './words.ts';

watchFailures();
await loadWords(document);
announceWhatToDo();

export { announce } from './banner.ts';
export { controls, type ControlSpec, type ControlValues } from './controls.ts';
export { playPickedVideo } from './media.ts';
export { leafTexture, matcapBall } from './painted.ts';
export { circling, ease, flights, mix, opening } from './opening.ts';
export { physicsReadouts } from './physicsReadouts.ts';
export { pointerOnPlane } from './pointer.ts';
export { profiling } from './profile.ts';
export { seeded, sineHash, valueNoise } from './random.ts';
export { readout } from './readout.ts';
export { walkingRobot } from './robot.ts';
export { vehicles } from './vehicles.ts';
export { brownNoise, whiteNoise } from './sound.ts';
export { stats } from './stats.ts';
export { tour } from './tour.ts';
export { healthCheck, showVerdict } from './verdict.ts';
export { language, words } from './words.ts';
export { isCapture, play, type Game, type PlayOptions } from './play.ts';
export type { GameKey, GameOption } from './gameMenu.ts';
