// A cut delta of the estate's scale (#824): 2 754 primitives, 15.8 M triangles. Index pages are
// content-addressed (`../row/pageSlots.ts`), so two primitives whose clusters carry the same index
// bytes share one cache key while each cluster keeps its own level. A key weighed at one level
// and released by a placement of another used to leave the wrong level list, drive its count
// below zero and throw "Invalid array length" out of `applyCut`.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PageRec } from '../../page/selection/selection.ts';
import { keysOf, rec, world } from './sets.fixture.ts';

/** 2 754 primitives of 45 clusters of 128 triangles, levels 0 to 4. */
const PRIMITIVES = 2754,
  CLUSTERS = 45,
  LEVELS = 5;

/** Every even primitive's first level-0 cluster carries the same index bytes as its odd
 *  neighbour's first level-1 cluster, so both sit at one address. */
function estate() {
  const packed: PageRec[] = [];
  for (let primitive = 0; primitive < PRIMITIVES; primitive++)
    for (let cluster = 0; cluster < CLUSTERS; cluster++) {
      const shared = cluster === (primitive & 1);
      packed.push(
        rec(shared ? `shared-${primitive >> 1}` : `p${primitive}-c${cluster}`, cluster % LEVELS),
      );
    }
  return world(packed);
}

test('a cut delta of the estate applies when placements of one address differ in level', () => {
  const { packed, tracking, sets, delta } = estate();
  const ids = (keep: (level: number) => boolean) => {
    const cut: number[] = [];
    for (let id = 0; id < packed.length; id++) if (keep(packed[id].level ?? 0)) cut.push(id);
    return cut;
  };
  // Far, then closer — both placements of a shared address held, the level-1 one first — then
  // near, where the level-1 placement leaves, then far again, where the level-0 one leaves last.
  for (const [label, cut] of [
    ['far', ids((level) => level >= 1)],
    ['closer', ids(() => true)],
    ['near', ids((level) => level === 0)],
    ['far again', ids((level) => level >= 1)],
  ] as const) {
    delta.apply(cut);
    sets.applyCut(delta);
    const keys = new Set(cut.map((id) => tracking.keyOf(packed[id])));
    assert.equal(sets.requestedCount, keys.size, `${label}: requested pages`);
    // A budget below the cut ranks it: every queued key belongs to the cut, once.
    const room = keys.size >> 1;
    assert.equal(sets.applyBudget(room), true, `${label}: over budget`);
    const queued = keysOf(tracking.wanted);
    assert.equal(queued.size, room, `${label}: queue fills the budget`);
    for (const key of queued) assert.ok(keys.has(key), `${label}: key ${key} left the cut`);
  }
});
