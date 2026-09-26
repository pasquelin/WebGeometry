//! The pages of the cell records (#750): each region page names the mesh pages its cells use
//! (#792).
use super::*;

/// Writes the pages of the cells `tree` halved, whose records and world boxes are `records` and
/// `bounds`; returns the root. A region page lists beside its records the slots of the mesh pages
/// its cells' primitives lie in, `mesh_pages` by mesh rank (#792), each once.
pub(crate) fn write_pages(
    tree: &Region,
    records: &[Value],
    bounds: &[Box6],
    mesh_pages: &MeshSlots,
    directory: &Path,
) -> Result<Value> {
    let mut starts = vec![0];
    for record in records {
        starts.push(starts[starts.len() - 1] + serde_json::to_vec(record)?.len() + 1);
    }
    let kind = &CELL_PAGES;
    let leaf = |cells: Range<usize>| {
        let records = &records[cells];
        let meshes = records
            .iter()
            .flat_map(|r| r["meshes"].as_array().into_iter().flatten());
        let pages = meshes.filter_map(|m| mesh_pages.get(&m[0].as_u64()?));
        let pages: BTreeSet<&String> = pages.flatten().collect();
        Ok(json!({kind.records: records, "meshPages": pages}))
    };
    let pager = Pager::new(kind, starts, bounds, directory, &leaf)?;
    Ok(json!({"version": kind.version, "pages": pager.root(tree)?}))
}
