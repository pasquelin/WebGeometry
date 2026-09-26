// A WebGL2 session of the effect chain's tests (#349): the engine's scene draw and the composer on
// a recorded context that renders half floats, the world's refusal and degradation notices, and
// what they said.
import * as G from '../../host/graph/graph.fixture.ts';
import type { RenderBackend } from '../../backend/types.ts';
import type { EffectChain } from '../../../../sdk-core/src/world/effect/chain.ts';
import type { GraphScene } from '../../host/graph/scene.ts';
import { createSceneDraw } from '../../webgl/cluster/sceneDraw.ts';
import { createTestContext } from '../../webgl/core/testContext.fixture.ts';
import {
  createWorldNotices,
  listenWorldNotices,
  noticeEffectRefusal,
  noticeMaterialDegraded,
} from '../diagnostic/worldNotices.ts';
import { createFrameComposer } from './compose.ts';

const camera = G.perspectiveCamera();
/** A context that renders half floats, as every desktop WebGL2 does. */
const HALF_FLOATS = {
  getExtension: (name: string) => (name === 'EXT_color_buffer_float' ? {} : null),
};

/** A WebGL2 session drawing `scene` with the world's `chain`, its refusals said on a world's
 *  notices; `frame` draws one and returns whether the chain ran and what the scene submitted.
 *  `between` writes the graph after the engine's `render`, as the engine's own frame does
 *  (`../../backend/autonomous/pages.ts`); `hold` says whether the engine holds its frames. */
export function session(scene: GraphScene, chain: EffectChain) {
  const context = createTestContext({ answers: HALF_FLOATS });
  const notices = createWorldNotices();
  const draw = createSceneDraw(context.gl, scene, [], {
    materialDegraded: noticeMaterialDegraded(notices),
  });
  const backend = { id: 'engine', scene, frameHeld: false, ...draw, ...draw.host };
  const refused = noticeEffectRefusal(notices);
  const compose = createFrameComposer(context.gl, camera, {
    effects: { chain, shown: () => true, refused },
  });
  return {
    frame(between?: () => void) {
      const passes = context.of('drawArrays').length,
        submitted = context.of('drawElements').length;
      draw.render(camera);
      between?.();
      compose(backend as unknown as RenderBackend, null);
      return {
        chained: context.of('drawArrays').length > passes,
        submitted: context.of('drawElements').length - submitted,
      };
    },
    hold(held: boolean) {
      backend.frameHeld = held;
    },
    close: notices.close,
  };
}

/** The kinds of every world notice said while `run` draws `view`, once delivered. */
export async function heard(view: ReturnType<typeof session>, run: () => void) {
  const said: string[] = [];
  const stop = listenWorldNotices((notice) => void said.push(notice.phase));
  run();
  await new Promise(setImmediate);
  view.close();
  stop();
  return said;
}
