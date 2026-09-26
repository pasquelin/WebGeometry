import type { NormalCone } from '../../page/cone/cone.ts';
import { prepareSdkWasm } from '../../page/decode/geometryPageWasm.ts';
import { reserveArena } from '../../page/decode/wasmArena.ts';

/**
 * The normal cone of each cluster the run-time cut writes, built by the compiler's own builder
 * (`packages/page-codec-wasm/src/normal_cone.rs`, `triangle_cone`) in the SDK module: a page cut
 * through the world API is cone-culled as a cooked one is, and no second builder exists.
 *
 * `null` when the module is not there, refuses the memory or the input: the pages then carry no
 * cone, which culls nothing and so changes no pixel.
 */
export async function clusterCones(
  positions: Float32Array,
  indices: Uint32Array,
  ranges: readonly (readonly [number, number])[],
): Promise<NormalCone[] | null> {
  const wasm = await prepareSdkWasm();
  if (!wasm || typeof wasm.cone_clusters !== 'function' || ranges.length === 0) return null;
  const arena = reserveArena(wasm, [
    { type: 'f32', longueur: positions.length },
    { type: 'u32', longueur: indices.length },
    { type: 'u32', longueur: ranges.length * 2 },
    { type: 'f64', longueur: ranges.length * 4 },
  ]);
  if (!arena) return null;
  try {
    const [p, i, r, out] = arena.blocs();
    p.vue.set(positions);
    i.vue.set(indices);
    ranges.forEach(([start, end], k) => {
      r.vue[k * 2] = start;
      r.vue[k * 2 + 1] = end;
    });
    const status = wasm.cone_clusters(
      p.offset,
      positions.length,
      i.offset,
      indices.length,
      r.offset,
      ranges.length,
      out.offset,
    );
    if (status !== 0) return null;
    // The builder allocates: its memory may have grown and detached the views taken above.
    const cones = arena.blocs()[3].vue;
    return ranges.map((_, k) => ({
      axis: [cones[k * 4], cones[k * 4 + 1], cones[k * 4 + 2]],
      angle: cones[k * 4 + 3],
    }));
  } finally {
    arena.libere();
  }
}
