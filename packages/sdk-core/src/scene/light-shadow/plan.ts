import { LIGHT_KIND, lightDirection, type ShadowViewpoint } from '../light/contracts.ts';
import { LIGHT_FIELD, type SceneLightStore } from '../light/store.ts';
import { baseOf } from '../light/fields.ts';
import { createShadowChanges } from './changes.ts';
import { createPageInvalidation } from './invalidate.ts';
import { createShadowCounts } from './counts.ts';
import { createShadowAdmission } from './admit.ts';
import { castsShadow } from './casters.ts';
import { createShadowTable } from './table.ts';
import { DRAW_ALL, createShadowPool } from './pool.ts';
import { createSunLevels } from './sunLevels.ts';
import { createShadowRecords } from './records.ts';
import { createShadowRequests, type ShadowRequestReport } from './requests.ts';
import { createShadowThresholds } from './thresholds.ts';
import { sunCoarseness } from './virtual.ts';

/** The frame's shadow work: which virtual pages are drawn. */
export type ShadowPlan = ReturnType<typeof createShadowPlan>;

/**
 * The shadow scheduler of the virtual maps. The shading records the pages it reads; their
 * report, read back frames later, allocates what is missing from the fixed pool. What moved stales
 * the mapped pages it covers. A frame then draws every stale page the image reads, all of them in
 * that frame (`admit.ts`): what holds the cost is the cache — a page is drawn again only when what
 * it holds changed —, and the pool is the only limit. A still scene, whose shading runs no more,
 * asks for nothing and draws nothing.
 *
 * All arrays are allocated once; `plan()` allocates nothing.
 */
export function createShadowPlan(poolSide: number) {
  const table = createShadowTable(poolSide * poolSide),
    pool = createShadowPool(poolSide),
    sun = createSunLevels(),
    records = createShadowRecords(table, pool, sun),
    requests = createShadowRequests(table, pool, records, sun),
    changes = createShadowChanges(pool.pages),
    counts = createShadowCounts(),
    invalidate = createPageInvalidation(pool, table, sun, changes, counts),
    admission = createShadowAdmission(pool.pages),
    thresholds = createShadowThresholds(pool),
    posed = new Int32Array(records.taken.length);
  let byPage = true,
    report: ShadowRequestReport | null = null,
    resting = false,
    views = 0,
    settledStamp = -1;
  const stampOf = (store: SceneLightStore) => table.version + views + store.epoch;
  return {
    /** The page table: one word per virtual page, and the range each light holds in it. */
    table,
    /** The physical pages of the pool and the virtual page each one holds. */
    pool,
    /** Each sun's clipmap: its frame, depth range, finest level and extents. */
    sun,
    /** The shadow slices, one per light that casts a shadow. */
    records,
    /** The request reports read back: what the latest one named, allocated or refused. */
    requests,
    /** What the last plan did, in pages. */
    counts,
    /** This frame's pages, the coarsest first, light view by light view. */
    admission,
    /** A node has moved: its box stales the pages it covers at the next plan. */
    worldChanged: changes.worldChanged,
    /** The same world at another precision: its box waits for the camera to rest. */
    representationChanged: changes.representationChanged,
    /** The threshold the light cuts select casters at (`thresholds.ts`). */
    setThreshold: thresholds.set,
    /** The camera rested at the last plan: its view was the one of the plan before. */
    get resting() {
      return resting;
    },
    /** True while a representation change waits for the camera to rest. */
    get deferredChanges() {
      return changes.deferred() || thresholds.pending;
    },
    /** The frame plans no shadow: the held union enters the list at once. */
    releaseDeferred: changes.releaseDeferred,
    /** Turns off per-page invalidation: a moving object stales every page of the lights it
     *  touches. On by default. */
    setPageInvalidation(on: boolean) {
      byPage = on;
    },
    /** Whether a moving object stales only the pages its box covers. */
    get pageInvalidation() {
      return byPage;
    },
    /** What the shading, the lights and the view hand the next image: a report stamped with it
     *  and naming nothing new proves the image reads only what is drawn. */
    stamp: stampOf,
    /** True once a report proves the current state asks for nothing: the image may hold. */
    settled: (store: SceneLightStore) => settledStamp === stampOf(store),
    /** A request report came back; the next plan reads it. A newer one replaces an unread one. */
    receive(next: ShadowRequestReport) {
      if (!report || next.frame > report.frame) report = next;
    },
    /** Plans a frame: stales what moved, reads the last report, admits every page to draw. */
    plan(
      store: SceneLightStore,
      view: ShadowViewpoint,
      sceneMin: ArrayLike<number>,
      sceneMax: ArrayLike<number>,
      frame: number,
      nowMs: number,
    ) {
      counts.beginFrame();
      records.release(store);
      const still = changes.observeView(view);
      resting = still;
      if (!still) views++;
      for (let slot = 0; slot < store.count; slot++) {
        if (!castsShadow(store, slot)) continue;
        const rank = store.packed[baseOf(slot) + LIGHT_FIELD.kind];
        let slice = store.sliceOf(slot);
        if (slice < 0) {
          slice = records.claim();
          // Every slice is held: this light lights unshadowed, and the frame counts it.
          if (slice < 0) {
            counts.unslicedCasters++;
            continue;
          }
          posed[slice] = frame;
        }
        records.fit(slice, rank);
        store.assignSlice(slot, slice);
        const light = store.light(store.ids[slot]);
        if (!light) continue;
        let whole = records.moved(slice, light);
        if (rank === LIGHT_KIND.directional) {
          if (sun.update(slice, lightDirection(light), view, sceneMin, sceneMax, frame))
            whole = true;
          // A page its level keeps is ranked again: a change of the finest level moves every
          // level's coarseness, and a view keeps one rank (`admit.ts`).
          for (let page = 0; page < pool.pages; page++) {
            if (pool.owner[page] < 0 || pool.slice[page] !== slice) continue;
            if (!sun.movedLevel(slice, pool.view[page])) continue;
            if (!sun.holds(slice, pool.view[page], pool.x[page], pool.y[page]))
              pool.release(table, page);
            else pool.rank[page] = sunCoarseness(pool.view[page], sun.finest[slice]);
          }
        }
        invalidate(light, slice, whole, byPage, nowMs, frame);
        if (whole) posed[slice] = frame;
      }
      changes.settled();
      if (still) counts.invalidatedPages += thresholds.restale(nowMs, frame);
      if (report) {
        const before = stampOf(store),
          read = report;
        report = null;
        requests.consume(read, nowMs, frame);
        if (read.stamp === before && requests.complete) settledStamp = stampOf(store);
      }
      requests.floors(posed, view, nowMs, frame);
      const count = admission.run(pool, table, requests.latest, frame, records.isFloor);
      for (let i = 0; i < count; i++) {
        const slice = pool.slice[admission.list[i]];
        counts.drewLight(slice, records.kind[slice], frame);
      }
      // What the pool cannot hold waits for nothing: it is published, never pending.
      counts.endFrame(pool, records, requests.latest, nowMs, frame);
      return count;
    },
    /** Pages `[from, to)` of the frame's list were encoded, page `from + i` in `modes[i]`: their
     *  draws land before anything reads them. The last batch closes the list. */
    commit(modes?: ArrayLike<number>, from = 0, to = admission.count) {
      for (let i = from; i < to; i++) {
        pool.drew(table, admission.list[i], modes ? modes[i - from] : DRAW_ALL);
        thresholds.drew(admission.list[i]);
      }
      if (to >= admission.count) admission.reset();
    },
    /** The frame's pages from `from` on could not be encoded: they stay stale, pending, ahead of
     *  every page that turns stale after them in the next frame's list (`admit.ts`). */
    reissue(from = 0) {
      counts.pendingPages = Math.max(0, admission.count - from);
      admission.reset(from);
    },
    /** Starts over. */
    reset() {
      records.reset();
      table.reset();
      pool.reset();
      thresholds.reset();
      requests.reset();
      changes.reset();
      counts.reset();
      admission.reset();
      report = null;
      resting = false;
      settledStamp = -1;
    },
  };
}
