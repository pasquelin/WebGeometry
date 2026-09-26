import { buildBlendStatics, refreshBlendPlan } from './plan.ts';
import { createWebgpuBlendState, type BlendGpuItem } from './state.ts';

/** A blend state holding `items`, its statics and encoding plan built as a frame would. */
export function blendSceneOf(items: readonly BlendGpuItem[]) {
  const blendState = createWebgpuBlendState();
  blendState.blendGpu.push(...items);
  buildBlendStatics(blendState);
  refreshBlendPlan(blendState);
  return blendState;
}
