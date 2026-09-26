import { LIGHT_KIND, type ShadowViewpoint } from '../light/contracts.ts';
import { createShadowNeeds } from './needs.ts';
import type { ShadowPool } from './pool.ts';
import type { ShadowRecords } from './records.ts';
import type { ShadowTable } from './table.ts';
import type { SunLevels } from './sunLevels.ts';
import {
  LAMP_FLOOR_MIP,
  PAGE_INDEX_MASK,
  PAGE_MAPPED,
  decodeLampEntry,
  lampCoarseness,
  lampEntry,
  lampFacesOf,
  sunCoarseness,
  sunEntry,
  shadowRequestCap,
  sunFloorLevel,
} from './virtual.ts';

/** What the shading read in one frame: the table entries it asked for, in no order. */
export interface ShadowRequestReport {
  /** Frame whose shading wrote the report. */
  frame: number;
  /** Table layout that frame read with (`ShadowTable.layoutEpoch`). */
  layoutEpoch: number;
  /** The plan's stamp when that frame was encoded (`ShadowPlan.stamp`). */
  stamp: number;
  /** Entries asked for, possibly more than `entries` holds: the rest ask again next frame. */
  count: number;
  /** The entries asked for, the first `count` of them at most. */
  entries: Uint32Array;
}

/**
 * Reads a request report back: every page the shading asked for is either touched — mapped, it
 * becomes the most recently requested — or allocated. Allocation goes coarse first, then by table
 * entry, so which pages a full pool refuses is the same from one run to the next: a sun's higher
 * levels and a lamp's higher mips cover the most pixels per page, and a finer page falls back to
 * them, so the pool never serves a fine page before the coarse one under it. Coarseness is
 * measured within each light (`sunCoarseness`, `lampCoarseness`).
 *
 * Every page named asks for its light's floor under it too (`sunFloorLevel`, `LAMP_FLOOR_MIP`):
 * what a reader falls back to last when that page is withdrawn. So the floor is mapped first, and
 * never evicted while anything above it is read; like every page named, it is drawn in the frame it
 * goes stale (`admit.ts`). The
 * floor covers all the light reaches, so it needs no report to know what the view will read: a
 * sun asks every frame for the floor pages its view reaches over the scene's box (`floors`) — past
 * it no caster lies, and a receiver there asks through the report —, and a new, moved or
 * reshaped lamp for each face's until a report written at its pose is read — a report from a past
 * pose names only the pages that pose's receivers read.
 *
 * A report read against another table layout is dropped: its words name ranges that moved. A sun
 * entry is read with the extents of the frame that wrote it, and dropped when its page has since
 * left the clipmap. Allocates nothing past construction.
 */
export function createShadowRequests(
  table: ShadowTable,
  pool: ShadowPool,
  records: ShadowRecords,
  sun: SunLevels,
) {
  const cap = shadowRequestCap(pool.pages),
    needs = createShadowNeeds(table, pool, 2 * cap), // each entry named, and its floor
    scratch = new Int32Array(4),
    /** What the entry being read names: its view, then its page. */
    at = new Int32Array(3);
  let reportFrame = -1;
  /** Entries read, allocated, refused for want of a page, and asked past the list (`unlisted`). */
  const counts = { requested: 0, allocated: 0, refused: 0, unlisted: 0, latest: -1 };
  const isSun = (slice: number) => records.kind[slice] === LIGHT_KIND.directional;
  /** Touches `entry` when it is mapped; else notes it to allocate, as `at` names it. */
  const ask = (entry: number, slice: number) => {
    const word = table.words[entry];
    if (word & PAGE_MAPPED) {
      const page = word & PAGE_INDEX_MASK;
      pool.requested[page] = Math.max(pool.requested[page], reportFrame);
      return;
    }
    const rank = isSun(slice)
      ? sunCoarseness(at[0], sun.finest[slice])
      : lampCoarseness(at[0] & 15);
    needs.note(entry, slice, at[0], at[1], at[2], rank);
  };
  /** Writes into `at` what unmapped `entry` of `slice` names; false when the clipmap left it. */
  const decode = (entry: number, slice: number) => {
    const relative = entry - table.baseOf(slice);
    if (isSun(slice)) {
      if (!sun.decode(slice, relative, reportFrame, scratch)) return false;
      if (!sun.holds(slice, scratch[0], scratch[1], scratch[2])) return false;
      for (let k = 0; k < 3; k++) at[k] = scratch[k];
      return true;
    }
    decodeLampEntry(relative, scratch);
    at[0] = scratch[0] * 16 + scratch[1];
    at[1] = scratch[2];
    at[2] = scratch[3];
    return true;
  };
  /** Asks for the floor page under the page `at` names, unless it is that page. */
  const askFloor = (slice: number) => {
    let entry = table.baseOf(slice);
    if (isSun(slice)) {
      const floor = sunFloorLevel(sun.finest[slice]);
      if (at[0] >= floor) return;
      const scale = 2 ** (floor - at[0]);
      at[0] = floor;
      at[1] = Math.floor(at[1] / scale);
      at[2] = Math.floor(at[2] / scale);
      if (!sun.holds(slice, at[0], at[1], at[2])) return;
      entry += sunEntry(at[0], at[1], at[2]);
    } else {
      if ((at[0] & 15) === LAMP_FLOOR_MIP) return;
      entry += lampEntry(at[0] >> 4, LAMP_FLOOR_MIP, 0, 0);
      at[0] = (at[0] & ~15) | LAMP_FLOOR_MIP;
      at[1] = at[2] = 0;
    }
    ask(entry, slice);
  };
  return {
    counts,
    /** Frame of the latest report read: the pages it named are the ones the image reads now. */
    get latest() {
      return counts.latest;
    },
    /**
     * True when the last report read changed nothing and asks for nothing the pool could still
     * take. A refusal is such a request: a page is refused only when every page of the pool is
     * one the report named. So is an entry past the list, once the named ones fill the pool —
     * the list holds at least as many entries as the pool holds pages (`shadowRequestCap`).
     */
    get complete() {
      return !counts.allocated && (!counts.unlisted || pool.heldBy(counts.latest));
    },
    consume(report: ShadowRequestReport, nowMs: number, frame: number) {
      counts.requested = Math.min(report.count, cap);
      counts.unlisted = report.count - counts.requested;
      counts.allocated = 0;
      counts.refused = 0;
      if (report.layoutEpoch !== table.layoutEpoch) return;
      counts.latest = reportFrame = report.frame;
      needs.clear();
      for (let i = 0; i < counts.requested; i++) {
        const entry = report.entries[i],
          word = table.words[entry];
        let slice: number;
        if (word & PAGE_MAPPED) {
          const page = word & PAGE_INDEX_MASK;
          slice = pool.slice[page];
          at[0] = pool.view[page];
          at[1] = pool.x[page];
          at[2] = pool.y[page];
        } else {
          slice = table.sliceAt(entry);
          if (slice < 0 || !decode(entry, slice)) continue;
        }
        ask(entry, slice);
        askFloor(slice);
      }
      needs.allocate(reportFrame, nowMs, frame, counts);
    },
    /** Asks, as if the latest report named them, for the floor pages a reader may need that no
     *  report names yet: every sun's over the scene within the view's far distance
     *  (`sun.floorReach`), whatever moved, and each face's of a lamp posed after that report — new,
     *  moved or reshaped: what it named was read at a past pose. Evicts only what it did not name;
     *  the next may evict it. */
    floors(posed: ArrayLike<number>, view: ShadowViewpoint, nowMs: number, frame: number) {
      reportFrame = counts.latest;
      for (let slice = 0; slice < posed.length; slice++) {
        if (records.kind[slice] < 0) continue;
        if (!isSun(slice) && posed[slice] <= counts.latest) continue;
        needs.clear();
        if (isSun(slice)) {
          const level = sunFloorLevel(sun.finest[slice]);
          sun.floorReach(slice, view, scratch);
          for (let y = scratch[1]; y <= scratch[3]; y++)
            for (let x = scratch[0]; x <= scratch[2]; x++) {
              at[0] = level;
              at[1] = x;
              at[2] = y;
              ask(table.baseOf(slice) + sunEntry(level, x, y), slice);
            }
        } else
          for (let face = 0; face < lampFacesOf(records.kind[slice]); face++) {
            at[0] = face * 16;
            askFloor(slice);
          }
        needs.allocate(reportFrame, nowMs, frame, counts);
      }
    },
    reset() {
      counts.requested = counts.allocated = counts.refused = counts.unlisted = 0;
      counts.latest = -1;
    },
  };
}
