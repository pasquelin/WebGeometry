//! The manifest's mesh pages under the page limit, and the region pages of the cells naming
//! exactly the mesh pages their cells use (#792).
//!
//! Provenance: synthetic primitives — `columns` reads their counts and one culling node each, not
//! their geometry — padded to a few hundred bytes each; the compiled worlds are `partition_pages.rs`'s.
use super::*;
use crate::compiler_manifest_pages::{write_mesh_pages, MANIFEST_PAGES};
use crate::compiler_tables::partition::pages::*;

/// Every region page of `kind` under `slots`, in record order, beside the slot that names it.
fn leaves(kind: &Kind, directory: &Path, slots: &Value) -> Vec<(String, Value)> {
    let mut found = Vec::new();
    for slot in slots.as_array().expect("slots") {
        let Some((_, page)) = read_slot(kind, directory, slot, "a test").expect("page") else {
            continue;
        };
        if page["pages"].is_array() {
            found.extend(leaves(kind, directory, &page["pages"]));
        } else {
            found.push((slot.as_str().expect("slot").to_string(), page));
        }
    }
    found
}

/// The mesh pages under the manifest root of `directory`, each proven under `PAGE_BYTES`: the
/// slots of those holding each mesh's primitives, by mesh rank.
fn mesh_pages(directory: &Path, slots: &Value) -> MeshSlots {
    let mut holding = MeshSlots::new();
    for (slot, page) in leaves(&MANIFEST_PAGES, directory, slots) {
        let bytes = usize::from_str_radix(&slot[64..72], 16).expect("size");
        assert!(bytes <= PAGE_BYTES, "a mesh page of {bytes} bytes");
        for primitive in page["primitives"].as_array().expect("primitives") {
            let pages = holding.entry(primitive["mesh"].as_u64().expect("mesh"));
            let pages = pages.or_default();
            if pages.last() != Some(&slot) {
                pages.push(slot.clone());
            }
        }
    }
    holding
}

/// Each region page of the cells under `partition` lists, sorted and once each, exactly the pages
/// of `holding` that hold a mesh its cells place.
fn assert_region_pages_name(directory: &Path, partition: &Value, holding: &MeshSlots) {
    for (_, page) in leaves(&CELL_PAGES, directory, &partition["pages"]) {
        let cells = page["cells"].as_array().expect("cells");
        let meshes = cells
            .iter()
            .flat_map(|c| c["meshes"].as_array().expect("meshes"));
        let ranks = meshes.map(|m| m[0].as_u64().expect("rank"));
        let used: BTreeSet<&String> = ranks.flat_map(|rank| &holding[&rank]).collect();
        let listed: Vec<String> = serde_json::from_value(page["meshPages"].clone()).expect("list");
        assert_eq!(listed.iter().collect::<Vec<_>>(), Vec::from_iter(used));
    }
}

/// The manifest of the compiled folder `directory` whose tables are `tables`: every mesh page
/// under the limit, every region page naming exactly the mesh pages its cells use.
pub(super) fn assert_mesh_pages(directory: &Path, tables: &Value) {
    let root = read_json(&directory.join(MANIFEST_FILE));
    let holding = mesh_pages(directory, &root["pages"]);
    assert!(!holding.is_empty(), "the primitives lie in mesh pages");
    assert_region_pages_name(directory, &tables["partition"], &holding);
}

#[test]
fn mesh_pages_are_cut_under_the_limit_and_give_every_primitive_back_in_order() {
    let directory = scratch("pages", "mesh");
    let pad = "x".repeat(200);
    let primitive = |at: usize| json!({"mesh": at / 50, "primitive": at % 50, "pages": [], "pad": pad, "culling": {"stride": crate::CULLING_STRIDE, "count": 1, "nodes": vec![at; crate::CULLING_STRIDE]}});
    let primitives: Vec<Value> = (0..5_000).map(primitive).collect();
    let paged = write_mesh_pages(&primitives, &directory).expect("mesh pages");
    let pages = leaves(&MANIFEST_PAGES, &directory, &json!(paged.slots));
    assert!(
        pages.len() > FAN_OUT,
        "{} region pages, under index pages",
        pages.len()
    );
    assert_eq!(mesh_pages(&directory, &json!(paged.slots)), paged.by_mesh);
    let order = |p: &Value| (p["mesh"].clone(), p["primitive"].clone());
    let listed = pages
        .iter()
        .flat_map(|(_, page)| page["primitives"].as_array().expect("list"));
    let read: Vec<_> = listed.map(order).collect();
    assert_eq!(
        read,
        primitives.iter().map(order).collect::<Vec<_>>(),
        "in order"
    );
    // Only a written page's column file reaches the disk: the files the pages name.
    let named: BTreeSet<String> = pages
        .iter()
        .map(|(_, page)| page["binary"]["url"].as_str().expect("url").into())
        .collect();
    let names = fs::read_dir(&directory)
        .expect("folder")
        .map(|e| e.expect("entry").file_name());
    let bins = names
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".bin"));
    assert_eq!(
        bins.collect::<BTreeSet<_>>(),
        named,
        "one column file per mesh page"
    );
    fs::remove_dir_all(directory).expect("cleanup");
}

#[test]
fn a_region_page_lists_exactly_the_mesh_pages_its_cells_use() {
    let directory = scratch("pages", "listing");
    let record = |at: usize| json!({"url": format!("scene-cell-{at}.json"), "parents": [], "meshes": [[at / 1_000, 1], [3, 1]]});
    let records: Vec<Value> = (0..3_000).map(record).collect();
    let bounds = vec![[0.0, 0.0, 0.0, 1.0, 1.0, 1.0]; records.len()];
    let slot = |digit: &str| digit.repeat(SLOT_WIDTH);
    let holding = MeshSlots::from([
        (0, vec![slot("a")]),
        (1, vec![slot("b"), slot("c")]),
        (2, vec![slot("c")]),
        (3, vec![]),
    ]);
    let tree = crate::compiler_tables::partition::split::halving(0..records.len());
    let partition = write_pages(&tree, &records, &bounds, &holding, &directory).expect("pages");
    assert_region_pages_name(&directory, &partition, &holding);
    let pages = leaves(&CELL_PAGES, &directory, &partition["pages"]);
    let firsts = pages
        .iter()
        .map(|(_, page)| page["meshPages"][0].to_string());
    assert!(
        firsts.collect::<BTreeSet<_>>().len() > 1,
        "pages list different meshes"
    );
    fs::remove_dir_all(directory).expect("cleanup");
}
