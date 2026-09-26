//! How placed nodes are grouped into cells: halved along the widest axis of their centres until
//! a cell's bytes fit one stream unit. Nothing here is a distance: the runtime derives when to
//! read a cell from its boxes and its own camera. The halving is kept: the paged cell index is cut
//! from its tree (`pages.rs`).
use super::*;
use std::ops::Range;

/// One placed node: its world box, the core rank of its parent (`None`: a scene root) and its box
/// in that parent's frame, its descriptor as the cell writes it, and that descriptor's size.
pub(in crate::compiler_tables) struct Placed {
    pub bounds: [f64; 6],
    pub parent: Option<usize>,
    pub local: [f64; 6],
    pub entry: Value,
    pub bytes: usize,
}
impl Placed {
    fn centre(&self, axis: usize) -> f64 {
        (self.bounds[axis] + self.bounds[axis + 3]) * 0.5
    }
}

/// A node of the halving tree: its contiguous range of cells, and its halves unless it is one.
pub(crate) struct Region {
    pub cells: Range<usize>,
    pub halves: Option<Box<[Region; 2]>>,
}

/// Halves `group` along the widest spread of its centres until each part fits the budget; a
/// single node is a cell whatever its size. Returns the tree of the halving.
fn halve(mut group: Vec<Placed>, out: &mut Vec<Vec<Placed>>) -> Region {
    let first = out.len();
    if group.len() <= 1
        || group.iter().map(|p| p.bytes).sum::<usize>() <= crate::STREAM_BUNDLE_BYTES
    {
        out.push(group);
        return Region {
            cells: first..first + 1,
            halves: None,
        };
    }
    let spread = |axis: usize| {
        let (low, high) = group
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(l, h), p| {
                (l.min(p.centre(axis)), h.max(p.centre(axis)))
            });
        high - low
    };
    let axis = (0..3)
        .max_by(|a, b| spread(*a).total_cmp(&spread(*b)))
        .unwrap_or(0);
    group.sort_by(|a, b| a.centre(axis).total_cmp(&b.centre(axis)));
    let upper = group.split_off(group.len() / 2);
    let halves = [halve(group, out), halve(upper, out)];
    Region {
        cells: first..out.len(),
        halves: Some(Box::new(halves)),
    }
}

/// The halving of `records` in order, in two down to single records: the tree of records that have
/// no place to halve by, as the manifest's primitives.
pub(crate) fn halving(records: Range<usize>) -> Region {
    let middle = records.start + records.len() / 2;
    let halves = (records.len() > 1)
        .then(|| Box::new([halving(records.start..middle), halving(middle..records.end)]));
    Region {
        cells: records,
        halves,
    }
}

/// The cells of `placed`, and the tree that halved them.
pub(super) fn split_cells(placed: Vec<Placed>) -> (Vec<Vec<Placed>>, Region) {
    let mut cells = Vec::new();
    let tree = halve(placed, &mut cells);
    (cells, tree)
}
