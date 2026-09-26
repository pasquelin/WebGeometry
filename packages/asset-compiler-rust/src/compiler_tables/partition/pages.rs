//! The paged index (#750): records lie in pages, each the node of the halving (`split.rs`) whose
//! records fit one page, under index pages of at most `FAN_OUT` pages cut from the same tree — no
//! second spatial partition. A root keeps only `FAN_OUT` slots of one width: its size does not
//! grow with the world. Each kind of record is paged so, under its own files and version (`Kind`).
use super::*;
use split::Region;
use std::{fmt::Write as _, ops::Range};

mod read;
pub(crate) use read::*;

/// The most bytes a region page of more than one record holds: one stream unit.
pub(crate) const PAGE_BYTES: usize = crate::STREAM_BUNDLE_BYTES;
/// How many pages the root and an index page list at most.
pub(crate) const FAN_OUT: usize = 8;
/// A slot: the page's SHA-256 in 64 hexadecimal digits, its size in 8, then its box — the union
/// of its records' at the declared poses — as the bits of six `f64` in 16 each. Zeros: no page.
pub(crate) const SLOT_WIDTH: usize = 64 + 8 + 6 * 16;

/// A kind of page: the prefix of its files, the version every page carries, and the member a
/// region page lists its records under.
pub(crate) struct Kind {
    pub prefix: &'static str,
    pub version: u32,
    pub records: &'static str,
}
/// The pages of the cell records.
pub(crate) const CELL_PAGES: Kind = Kind {
    prefix: "scene-page-",
    version: PARTITION_VERSION,
    records: "cells",
};

/// Writes `body` as a page of `kind` in `directory`, boxed by the union of `boxes`; its slot.
pub(crate) fn write_page(
    kind: &Kind,
    directory: &Path,
    body: &Value,
    boxes: &[Box6],
) -> Result<String> {
    let bytes = serde_json::to_vec(body)?;
    let sha256 = hash(&bytes);
    atomic(
        &directory.join(format!("{}{sha256}.json", kind.prefix)),
        &bytes,
    )?;
    let mut bounds = EMPTY;
    for record in boxes {
        grow(&mut bounds, record);
    }
    let mut slot = format!("{sha256}{:08x}", bytes.len());
    for value in bounds {
        write!(slot, "{:016x}", value.to_bits()).expect("a string takes any write");
    }
    Ok(slot)
}

/// The records of one kind of page, their boxes, and where each record starts once written.
pub(crate) struct Pager<'a> {
    kind: &'a Kind,
    /// The bytes of a region page of no record, as `leaf` lays it out.
    empty: usize,
    /// Where each record starts in a region page's list, and where the last ends.
    starts: Vec<usize>,
    /// The box of each record.
    bounds: &'a [Box6],
    directory: &'a Path,
    /// The region page over a range of records, its version aside.
    leaf: &'a dyn Fn(Range<usize>) -> Result<Value>,
}

impl<'a> Pager<'a> {
    /// The pager of `kind` over records starting at `starts`, boxed by `bounds`, whose region pages
    /// `leaf` lays out: the bytes of an empty region page are measured on `leaf` itself.
    pub(crate) fn new(
        kind: &'a Kind,
        starts: Vec<usize>,
        bounds: &'a [Box6],
        directory: &'a Path,
        leaf: &'a dyn Fn(Range<usize>) -> Result<Value>,
    ) -> Result<Self> {
        let mut pager = Pager {
            kind,
            empty: 0,
            starts,
            bounds,
            directory,
            leaf,
        };
        pager.empty = serde_json::to_vec(&pager.region(0..0)?)?.len();
        Ok(pager)
    }

    /// The region page over `records`, its version stamped.
    fn region(&self, records: Range<usize>) -> Result<Value> {
        let mut body = (self.leaf)(records)?;
        body["version"] = json!(self.kind.version);
        Ok(body)
    }

    /// Whether `region` is a region page: one record, or records that fit `PAGE_BYTES`.
    fn fits(&self, region: &Region) -> bool {
        let (starts, cells) = (&self.starts, &region.cells);
        region.halves.is_none()
            || self.empty + starts[cells.end] - starts[cells.start] <= PAGE_BYTES
    }

    /// The slots of the pages listing `region`'s records in order, each written: its halving
    /// opened, the node of most records first, until `FAN_OUT` pages or every one is a region page.
    fn slots(&self, region: &Region) -> Result<Vec<String>> {
        let mut pages = vec![region];
        while pages.len() < FAN_OUT {
            let open = (0..pages.len()).filter(|at| !self.fits(pages[*at]));
            let Some(at) = open.max_by_key(|at| pages[*at].cells.len()) else {
                break;
            };
            let halves = pages[at]
                .halves
                .as_deref()
                .expect("a region that does not fit");
            pages.splice(at..=at, halves);
        }
        pages.into_iter().map(|page| self.write(page)).collect()
    }

    /// Writes `region` as a region page, or as an index page over its slots; its slot.
    fn write(&self, region: &Region) -> Result<String> {
        let body = if self.fits(region) {
            self.region(region.cells.clone())?
        } else {
            json!({"version": self.kind.version, "pages": self.slots(region)?})
        };
        let boxes = &self.bounds[region.cells.clone()];
        write_page(self.kind, self.directory, &body, boxes)
    }

    /// The root's slots over `tree`, the empty ones last.
    pub(crate) fn root(&self, tree: &Region) -> Result<Vec<String>> {
        let mut slots = self.slots(tree)?;
        slots.resize(FAN_OUT, "0".repeat(SLOT_WIDTH));
        Ok(slots)
    }
}

/// Writes the pages of the cells `tree` halved, whose records and world boxes are `records` and
/// `bounds`; returns the root.
pub(crate) fn write_pages(
    tree: &Region,
    records: &[Value],
    bounds: &[Box6],
    directory: &Path,
) -> Result<Value> {
    let mut starts = vec![0];
    for record in records {
        starts.push(starts[starts.len() - 1] + serde_json::to_vec(record)?.len() + 1);
    }
    let kind = &CELL_PAGES;
    let leaf = |cells: Range<usize>| Ok(json!({kind.records: &records[cells]}));
    let pager = Pager::new(kind, starts, bounds, directory, &leaf)?;
    Ok(json!({"version": kind.version, "pages": pager.root(tree)?}))
}
