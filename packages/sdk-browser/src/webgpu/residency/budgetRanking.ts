import type { PageRec } from '../../page/selection/selection.ts';
import { createSparseInts } from '../../page/cut/sparseInts.ts';

/**
 * Ranks the cut the page budget has to cut down: coarsest level first, and within a level the order
 * the pages joined the weighed set.
 *
 * What is weighed is **pages**, not placements. The budget it is compared against is a number of
 * cache slots, and a slot holds a page: two placements of one page — the same cluster under two
 * instances of an object — occupy one slot and must count once. Counting placements made the budget
 * refuse cuts that fit ten times over, and the queue it then wrote was a prefix whose page count
 * depended on how the placements happened to be distributed, so the resident set depended on the
 * order the network had filled it in.
 *
 * Ranking no longer walks the cut. Weighed keys are stored PER LEVEL at the moment they enter
 * and leave — the only thing that moves them — so the prefix is written by reading the coarsest
 * levels first and stopping at the budget: its cost is that of the budget, never that of the
 * cut. What the prefix contains is unchanged in kind — a full cover plus as much detail as the
 * budget carries, never a truncated surface cut — and its internal order is now stable from
 * frame to frame, where the shown-list publication order, taken from an atomic counter, used to
 * reshuffle it every frame and rewrite the queue for nothing.
 *
 * Its tables follow the weighed keys, never the catalogue (#483 rule 6), and nothing is allocated
 * once the budget, the levels and the view of a scene are known.
 */
export function createBudgetRanking(options: {
  bootstrapKey: Uint8Array;
  keyOf: (page: PageRec) => number;
}) {
  const { bootstrapKey, keyOf } = options;
  /** Non-cover pages of the opaque cut, per level: their count, and the list of their keys. */
  let held = new Int32Array(8);
  const lists: Int32Array[] = [];
  /** Beside each level's keys, the first placement that named each: the record it is looked up by. */
  const pageLists: PageRec[][] = [];
  /** Placements holding each weighed key, its slot in its level plus one, and that level plus one:
   *  a key counts once however many hold it. Index pages are content-addressed
   *  (`../row/pageSlots.ts`), so placements of one key may carry different levels: the key is filed
   *  at the coarsest level a placement brought it at since it joined, never finer than a holder's —
   *  a cover page is never ranked behind detail — and it leaves the list it is filed in (#824). */
  const refs = createSparseInts(),
    slotOf = createSparseInts(),
    levelOfKey = createSparseInts();
  /** The ranked prefix, one entry per page, and the keys beside it. Sized to the budget once. */
  const ranked: PageRec[] = [];
  let keys = new Int32Array(0);
  let length = 0,
    weighed = 0;
  const grow = (level: number) => {
    if (level >= held.length) {
      const size = 1 << (32 - Math.clz32(level));
      const next = new Int32Array(size);
      next.set(held);
      held = next;
    }
    const list = lists[level];
    if (list && held[level] < list.length) return list;
    const size = Math.max(8, (list?.length ?? 0) * 2);
    const next = new Int32Array(size);
    if (list) next.set(list);
    return (lists[level] = next);
  };
  /** Files `key` at the end of `level`'s list, beside the record it is looked up by. */
  const file = (key: number, page: PageRec, level: number) => {
    const list = grow(level),
      slot = held[level]++;
    slotOf.set(key, slot + 1);
    levelOfKey.set(key, level + 1);
    list[slot] = key;
    (pageLists[level] ??= [])[slot] = page;
  };
  /** Takes `key` out of its level's list: the last key of the level takes the freed slot, so the
   *  list stays dense without being sorted. */
  const unfile = (key: number) => {
    const level = levelOfKey.set(key, 0) - 1,
      list = lists[level],
      pages = pageLists[level],
      slot = slotOf.set(key, 0) - 1,
      end = --held[level];
    if (slot !== end) {
      list[slot] = list[end];
      pages[slot] = pages[end];
      slotOf.set(list[slot], slot + 1);
    }
    pages.length = end;
  };
  return {
    ranked,
    /** Bytes of the per-key tables and the level lists, all sized by the weighed keys. */
    get byteLength() {
      return (
        refs.byteLength +
        slotOf.byteLength +
        levelOfKey.byteLength +
        held.byteLength +
        keys.byteLength +
        lists.reduce((bytes, list) => bytes + (list?.byteLength ?? 0), 0)
      );
    },
    get keys() {
      return keys;
    },
    get length() {
      return length;
    },
    /** Pages of the opaque cut the budget weighs, the pinned cover excluded. */
    get pageCount() {
      return weighed;
    },
    /** One placement of the opaque cut joins the weighed set; the cover is never weighed. */
    add(page: PageRec) {
      const key = keyOf(page);
      if (bootstrapKey[key]) return;
      const level = page.level ?? 0;
      if (refs.add(key, 1) === 1) {
        file(key, page, level);
        weighed++;
      } else if (level + 1 > levelOfKey.get(key)) {
        // A coarser placement of a shared address: the key moves up to the level it now covers.
        unfile(key);
        file(key, page, level);
      }
    },
    /** One placement leaves it; the page leaves only with its last placement. */
    remove(page: PageRec) {
      const key = keyOf(page);
      if (bootstrapKey[key] || refs.get(key) <= 0 || refs.add(key, -1) > 0) return;
      unfile(key);
      weighed--;
    },
    /** True when the queue already holds exactly the ranked prefix, in the same order. */
    matches(list: Int32Array, count: number, pages: readonly PageRec[]) {
      if (count !== length) return false;
      for (let i = 0; i < length; i++)
        if (list[i] !== keys[i] || pages[i] !== ranked[i]) return false;
      return true;
    },
    /**
     * Counts the pages the budget weighs and, when that overruns `room`, writes the prefix it keeps
     * into `ranked`/`keys`. Returns the page count so the caller can tell a cut that fits from one
     * that does not without counting it twice.
     */
    rank(room: number) {
      const records = weighed;
      if (records <= room) return records;
      if (keys.length < room) {
        keys = new Int32Array(room);
        ranked.length = room;
      }
      // The coarsest levels are kept whole until one of them straddles the budget; that one gives its
      // first `atCut` pages and the finer levels give none.
      let taken = 0,
        floor = 0,
        atCut = 0;
      for (let level = held.length - 1; level >= 0; level--) {
        if (taken + held[level] >= room) {
          floor = level;
          atCut = room - taken;
          break;
        }
        taken += held[level];
      }
      // Two loops and not a closure: that one was allocated at every ranking and pushed its cursor
      // out of registers, over as many iterations as the budget carries pages.
      let at = 0;
      for (let level = held.length - 1; level >= floor; level--) {
        const list = lists[level],
          pages = pageLists[level],
          take = level > floor ? held[level] : atCut;
        for (let i = 0; i < take; i++) {
          keys[at] = list[i];
          ranked[at++] = pages[i];
        }
      }
      length = at;
      return records;
    },
  };
}
