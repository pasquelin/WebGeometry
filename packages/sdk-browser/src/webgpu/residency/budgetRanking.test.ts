// Page-budget ranking no longer walks the cut: weighed keys are stored by level as they enter
// and leave, and the prefix is read from the coarsest levels up to the budget. What it contains
// is unchanged in kind — whole coarse levels, then as much of the level that straddles the
// budget as that budget carries, and nothing finer.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PageRec } from '../../page/selection/selection.ts';
import { createBudgetRanking } from './budgetRanking.ts';

const keyOf = (page: PageRec) => page.keyIndex as number;
const rec = (key: number, level: number | undefined, tag: string) =>
  ({ url: tag, keyIndex: key, level }) as unknown as PageRec;

/** Pages the budget weighs: the cut's distinct keys, the cover excluded. */
const weighed = (cut: readonly PageRec[], cover: Uint8Array) =>
  new Set(cut.filter((page) => !cover[keyOf(page)]).map(keyOf));

/** What the prefix must contain, level by level: whole coarse ones, then the rest of the budget
 *  taken from the level that straddles it, and nothing below. A set per level, not an order: a
 *  level's internal order is that of the entries, and it is no longer a promise. */
function reference(cut: readonly PageRec[], cover: Uint8Array, room: number) {
  const byLevel = new Map<number, Set<number>>();
  for (const page of cut) {
    const key = keyOf(page);
    if (cover[key]) continue;
    const level = page.level ?? 0;
    if (!byLevel.has(level)) byLevel.set(level, new Set());
    byLevel.get(level)!.add(key);
  }
  const levels = [...byLevel.keys()].sort((a, b) => b - a);
  const taken = new Map<number, number>();
  let left = room;
  for (const level of levels) {
    const size = byLevel.get(level)!.size;
    taken.set(level, Math.min(size, left));
    left = Math.max(0, left - size);
  }
  return { byLevel, taken };
}

/** Returned prefix, checked against the reference: count per level, membership, uniqueness. */
function check(
  ranking: ReturnType<typeof createBudgetRanking>,
  cut: readonly PageRec[],
  cover: Uint8Array,
  room: number,
  label: string,
) {
  const records = ranking.rank(room);
  assert.equal(records, weighed(cut, cover).size, `${label}: weighed pages`);
  if (records <= room) return;
  const want = reference(cut, cover, room);
  const keys = [...ranking.keys.subarray(0, ranking.length)];
  assert.equal(keys.length, room, `${label}: the prefix equals the budget`);
  assert.equal(new Set(keys).size, room, `${label}: one entry per page`);
  const counted = new Map<number, number>();
  keys.forEach((key, index) => {
    const page = ranking.ranked[index];
    assert.equal(keyOf(page), key, `${label}: the record is that of the key`);
    const level = page.level ?? 0;
    assert.ok(want.byLevel.get(level)?.has(key), `${label}: key weighed at its level`);
    counted.set(level, (counted.get(level) ?? 0) + 1);
  });
  for (const [level, count] of want.taken)
    assert.equal(counted.get(level) ?? 0, count, `${label}: pages taken at level ${level}`);
}

/** A reproducible pseudo-random stream: the sweep below has to be the same on every run. */
function stream(seed: number) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

test('the prefix keeps whole coarse levels and cuts in the one that straddles', () => {
  const next = stream(20260915);
  for (let trial = 0; trial < 200; trial++) {
    const keyCount = 1 + Math.floor(next() * 40);
    const cover = new Uint8Array(keyCount);
    for (let key = 0; key < keyCount; key++) cover[key] = next() < 0.2 ? 1 : 0;
    // A level belongs to the page, not to the placement: two placements of one cluster are the same
    // cluster, at the same level, in one cache slot.
    const levels = Array.from({ length: keyCount }, () =>
      next() < 0.1 ? undefined : Math.floor(next() * 13),
    );
    const cut: PageRec[] = [];
    const count = Math.floor(next() * 120);
    for (let i = 0; i < count; i++) {
      const key = Math.floor(next() * keyCount);
      cut.push(rec(key, levels[key], `p${i}`));
    }
    const room = Math.floor(next() * (count + 3));
    const ranking = createBudgetRanking({ bootstrapKey: cover, keyOf });
    for (const page of cut) ranking.add(page);
    check(ranking, cut, cover, room, `trial ${trial}`);
  }
});

test('a placement that leaves is subtracted, and the rank follows the cut that remains', () => {
  const cover = new Uint8Array(6);
  cover[0] = 1;
  const cut = [
    rec(0, 3, 'cover'),
    rec(1, 0, 'fine-a'),
    rec(2, 2, 'coarse-a'),
    rec(3, 1, 'mid'),
    rec(2, 2, 'coarse-a-again'),
    rec(4, 2, 'coarse-b'),
  ];
  const ranking = createBudgetRanking({ bootstrapKey: cover, keyOf });
  for (const page of cut) ranking.add(page);
  // Four pages, not five placements: the two `coarse-a` records share one slot.
  assert.equal(ranking.rank(3), 4);
  // Coarsest first, entry order inside a level, one entry per page.
  assert.deepEqual([...ranking.keys.subarray(0, ranking.length)], [2, 4, 3]);
  // The two coarse-a placements leave; what is left is mid then fine, and it now fits.
  ranking.remove(cut[2]);
  ranking.remove(cut[4]);
  assert.equal(ranking.rank(3), 3);
  assert.equal(ranking.pageCount, 3);
  assert.equal(ranking.rank(2), 3);
  assert.deepEqual([...ranking.keys.subarray(0, ranking.length)], [4, 3]);
});

test('a ranking that nothing moves yields the same prefix twice', () => {
  const cover = new Uint8Array(8);
  const cut = [0, 1, 2, 3, 4, 5, 6, 7].map((key) => rec(key, key % 3, `p${key}`));
  const ranking = createBudgetRanking({ bootstrapKey: cover, keyOf });
  for (const page of cut) ranking.add(page);
  ranking.rank(5);
  const premier = [...ranking.keys.subarray(0, ranking.length)],
    pages = ranking.ranked.slice(0, ranking.length);
  ranking.rank(5);
  assert.deepEqual([...ranking.keys.subarray(0, ranking.length)], premier, 'same order');
  assert.equal(
    ranking.matches(Int32Array.from(premier), premier.length, pages),
    true,
    'the queue that already holds this prefix is recognised, so never rewritten',
  );
  assert.equal(ranking.matches(Int32Array.from(premier), 4, pages), false, 'different length');
});

test('levels beyond the first band grow the counters without disturbing the rank', () => {
  const cover = new Uint8Array(3);
  const cut = [rec(0, 0, 'zero'), rec(1, 40, 'haut'), rec(2, 9, 'milieu')];
  const ranking = createBudgetRanking({ bootstrapKey: cover, keyOf });
  for (const page of cut) ranking.add(page);
  check(ranking, cut, cover, 2, 'high levels');
  assert.deepEqual([...ranking.keys.subarray(0, ranking.length)], [1, 2]);
});

test('a shared address ranks at its coarsest holder and leaves the list it is filed in', () => {
  // Index pages are content-addressed (#824): key 1 is held by a fine and a coarse placement.
  const cover = new Uint8Array(4);
  const shared = [rec(1, 0, 'fine-shared'), rec(1, 2, 'coarse-shared')];
  const ranking = createBudgetRanking({ bootstrapKey: cover, keyOf });
  ranking.add(shared[0]);
  ranking.add(rec(2, 1, 'mid'));
  ranking.add(shared[1]);
  ranking.add(rec(3, 0, 'fine'));
  // The coarse holder files the key first, ahead of the mid-level page, though the fine one came first.
  assert.equal(ranking.rank(1), 3);
  assert.deepEqual([...ranking.keys.subarray(0, ranking.length)], [1]);
  // The fine placement leaves first, then the coarse one: the key leaves its level once.
  ranking.remove(shared[0]);
  assert.equal(ranking.pageCount, 3);
  ranking.remove(shared[1]);
  assert.equal(ranking.pageCount, 2);
  assert.equal(ranking.rank(1), 2);
  assert.deepEqual([...ranking.keys.subarray(0, ranking.length)], [2]);
});
