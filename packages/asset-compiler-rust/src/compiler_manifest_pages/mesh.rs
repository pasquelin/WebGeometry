//! The mesh pages (#792): the primitives cut under `PAGE_BYTES` through the pager of the cell
//! index, written before the scene tables whose region pages name them.
use super::*;
use crate::compiler_tables::partition::split::halving;
use std::{cell::RefCell, ops::Range};

/// What a run reports of each primitive — how many of its pages it found already built — rather
/// than what it built: the head keeps it, one per primitive, so a rebuild writes the same mesh
/// pages and the same region pages naming them.
pub(super) const RUN_REPORT: &str = "reusedPages";

/// `page` without the run's report of its primitives.
pub(super) fn without_run_report(mut page: Value) -> Value {
    for primitive in page[MANIFEST_PAGES.records]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        primitive.as_object_mut().map(|p| p.remove(RUN_REPORT));
    }
    page
}

/// The mesh pages of a compile, written before the tables whose region pages name them (#792).
pub(crate) struct MeshPages {
    /// The root's slots, the empty ones last.
    pub slots: Vec<String>,
    /// The slots of the region pages each mesh's primitives lie in, by mesh rank.
    pub by_mesh: MeshSlots,
    /// The fingerprints of every page and sidecar written, which the sweep keeps.
    pub(super) kept: BTreeSet<String>,
}

/// Writes `primitives` in order as mesh pages in `directory`, cut through the pager: a region page
/// is one primitive, or primitives whose page fits `PAGE_BYTES`, each with its own sidecar.
pub(crate) fn write_mesh_pages(primitives: &[Value], directory: &Path) -> Result<MeshPages> {
    let kind = &MANIFEST_PAGES;
    let whole = without_run_report(columns(&Map::new(), primitives, &TEMPLATES, &[])?.0);
    let slim = whole[kind.records]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let kept = RefCell::new(BTreeSet::new());
    let leaf = |range: Range<usize>, written: bool| {
        let place = written.then_some(directory);
        let (page, sha256) = columned(&Map::new(), &primitives[range], &[], place)?;
        if written {
            kept.borrow_mut().insert(sha256);
        }
        Ok(page)
    };
    let pager = Pager::new(kind, slim, None, directory, &leaf)?;
    let slots = pager.root(&halving(0..primitives.len()))?;
    let mut by_mesh = MeshSlots::new();
    for (records, slot) in pager.written() {
        kept.borrow_mut().insert(slot[..64].to_string());
        let listed = records.map_or(&[][..], |records| &primitives[records]);
        for mesh in listed.iter().filter_map(|p| p["mesh"].as_u64()) {
            let pages: &mut Vec<String> = by_mesh.entry(mesh).or_default();
            if pages.last() != Some(&slot) {
                pages.push(slot.clone());
            }
        }
    }
    let kept = kept.into_inner();
    Ok(MeshPages {
        slots,
        by_mesh,
        kept,
    })
}
