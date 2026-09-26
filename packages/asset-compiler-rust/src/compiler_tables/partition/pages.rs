//! The paged index (#750): records lie in pages, each the node of the halving (`split.rs`) whose
//! records fit one page, under index pages of at most `FAN_OUT` pages cut from the same tree — no
//! second spatial partition. A root keeps only `FAN_OUT` slots of one width: its size does not
//! grow with the world. Each kind of record is paged so, under its own files and version (`Kind`).
use super::*;
use split::Region;
use std::{cell::RefCell, fmt::Write as _, ops::Range};

mod cells;
mod read;
pub(crate) use cells::*;
pub(crate) use read::*;

/// The most bytes a region page of more than one record holds: one stream unit.
pub(crate) const PAGE_BYTES: usize = crate::STREAM_BUNDLE_BYTES;
/// How many pages the root and an index page list at most.
pub(crate) const FAN_OUT: usize = 8;
/// The slots of the mesh pages each mesh's primitives lie in, by mesh rank (#792).
pub(crate) type MeshSlots = BTreeMap<u64, Vec<String>>;
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
    /// The box of each record; none, and every page is unboxed.
    bounds: &'a [Box6],
    directory: &'a Path,
    /// The region page over a range of records, its version aside.
    leaf: &'a dyn Fn(Range<usize>) -> Result<Value>,
    /// Each range measured, and its region page when it is one.
    measured: RefCell<BTreeMap<(usize, usize), Option<Value>>>,
    /// The region pages written, in record order: their records and slot.
    leaves: RefCell<Vec<(Range<usize>, String)>>,
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
            measured: RefCell::default(),
            leaves: RefCell::default(),
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

    /// Whether `region` is a region page: one record, or records whose page fits `PAGE_BYTES`. Its
    /// page is laid out once, and only when its records and their commas alone would fit.
    fn fits(&self, region: &Region) -> Result<bool> {
        let (cells, one) = (&region.cells, region.halves.is_none());
        let key = (cells.start, cells.end);
        if let Some(page) = self.measured.borrow().get(&key) {
            return Ok(page.is_some());
        }
        let least = self.empty + self.starts[cells.end] - self.starts[cells.start];
        let mut page = None;
        if one || least <= PAGE_BYTES + 1 {
            let body = self.region(cells.clone())?;
            page = (one || serde_json::to_vec(&body)?.len() <= PAGE_BYTES).then_some(body);
        }
        let fits = page.is_some();
        self.measured.borrow_mut().insert(key, page);
        Ok(fits)
    }

    /// The slots of the pages listing `region`'s records in order, each written: its halving
    /// opened, the node of most records first, until `FAN_OUT` pages or every one is a region page.
    fn slots(&self, region: &Region) -> Result<Vec<String>> {
        let mut pages = vec![region];
        while pages.len() < FAN_OUT {
            let mut open = Vec::new();
            for (at, page) in pages.iter().enumerate() {
                if !self.fits(page)? {
                    open.push(at);
                }
            }
            let Some(at) = open.into_iter().max_by_key(|at| pages[*at].cells.len()) else {
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
        let cells = region.cells.clone();
        let leaf = self.fits(region)?;
        let body = if leaf {
            let measured = self.measured.borrow_mut().remove(&(cells.start, cells.end));
            measured.flatten().expect("a region page, measured")
        } else {
            json!({"version": self.kind.version, "pages": self.slots(region)?})
        };
        let boxes = self.bounds.get(cells.clone()).unwrap_or(&[]);
        let slot = write_page(self.kind, self.directory, &body, boxes)?;
        if leaf {
            self.leaves.borrow_mut().push((cells, slot.clone()));
        }
        Ok(slot)
    }

    /// The root's slots over `tree`, the empty ones last.
    pub(crate) fn root(&self, tree: &Region) -> Result<Vec<String>> {
        let mut slots = self.slots(tree)?;
        slots.resize(FAN_OUT, "0".repeat(SLOT_WIDTH));
        Ok(slots)
    }

    /// The region pages written, in record order: the records each lists, and its slot.
    pub(crate) fn leaves(self) -> Vec<(Range<usize>, String)> {
        self.leaves.into_inner()
    }
}
