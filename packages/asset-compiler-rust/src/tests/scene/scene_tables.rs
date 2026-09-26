//! Correctness of `scene-tables.json`, the node table and the geometry layout of each published
//! document (#287, #272). Its material table is proven by `surface_tables.rs`.
//!
//! Provenance of every case: the glTF the compilation itself publishes as `source.gltf`, built
//! here from the repository's own triangle fixture (`tests/base.rs`) — no asset is read from
//! outside this crate. Each case names the glTF field it comes from, so what the table claims can
//! be traced back to the specification it is read from.
use super::*;
use crate::tests::cache::reuse::compile_with_events;

/// Cube corners on the fixture triangle's accessor, so a world box has something to grow from.
fn with_bounds(gltf: &mut Value) {
    gltf["accessors"][0]["min"] = json!([0.0, 0.0, 0.0]);
    gltf["accessors"][0]["max"] = json!([1.0, 1.0, 0.0]);
}
/// The tables a compilation published, as the runtime will read them.
pub(in crate::tests) fn tables_of(options: &Options) -> Value {
    let result = compile(options, |_| {}).expect("compile");
    let directory = options.key_directory(result["key"].as_str().expect("key"));
    read_json(&directory.join("scene-tables.json"))
}
/// A full-scope compilation of the fixture, altered by the case before it is written back.
pub(in crate::tests) fn published(alter: impl FnOnce(&mut Value)) -> (PathBuf, Value) {
    let (root, mut options) = fixture();
    let mut gltf = read_gltf(&options);
    with_bounds(&mut gltf);
    alter(&mut gltf);
    write_gltf(&options, &gltf, None);
    options.scope = "full".into();
    let tables = tables_of(&options);
    (root, tables)
}

#[test]
fn the_node_table_carries_every_node_and_its_local_pose() {
    // A parent that moves its two children: the pose written is the one each node declares, which
    // the runtime composes itself — the same bits the document gives.
    let (_root, tables) = published(|gltf| {
        gltf["scenes"] = json!([{"name":"stage","nodes":[0]}]);
        gltf["nodes"] = json!([
            {"name":"root","translation":[10.0,0.0,0.0],"children":[1,2]},
            {"name":"left","mesh":0},
            {"name":"right","mesh":0,"matrix":[1.0,0.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,0.0,1.0,0.0,0.0,2.0,0.0,1.0]},
        ]);
    });
    assert_eq!(tables["scene"], json!({"name":"stage","nodes":[0]}));
    let nodes = tables["nodes"].as_array().expect("nodes");
    assert_eq!(nodes.len(), 3, "every node, drawn or not: {tables}");
    assert_eq!(
        nodes[0]["children"],
        json!([1, 2]),
        "the hierarchy is in the table"
    );
    assert_eq!(nodes[0]["translation"], json!([10.0, 0.0, 0.0]));
    assert_eq!(nodes[0]["mesh"], Value::Null);
    assert_eq!(
        nodes[1]["mesh"],
        json!(0),
        "two nodes naming one mesh: instancing"
    );
    assert_eq!(nodes[2]["mesh"], json!(0));
    assert_eq!(
        nodes[2]["matrix"][13],
        json!(2.0),
        "a matrix pose is kept as a matrix"
    );
    assert_eq!(
        nodes[1]["matrix"],
        Value::Null,
        "no pose declared, none invented"
    );
}

#[test]
fn the_documents_lay_out_every_primitive_in_its_binary() {
    let (_root, tables) = published(|_| {});
    let source = &tables["documents"]["source.gltf"];
    assert_eq!(source["buffer"], json!("source.bin"));
    let primitive = &source["meshes"][0]["primitives"][0];
    let position = &source["accessors"][primitive["attributes"]["POSITION"]
        .as_u64()
        .expect("position") as usize];
    assert_eq!(position["componentType"], json!(5126));
    assert_eq!(position["type"], json!("VEC3"));
    assert_eq!(position["count"], json!(3));
    assert_eq!(
        (position["min"].clone(), position["max"].clone()),
        (json!([0.0, 0.0, 0.0]), json!([1.0, 1.0, 0.0])),
        "the box the positions declare, which the host bounds its geometry by"
    );
    let view = &source["views"][position["view"].as_u64().expect("view") as usize];
    assert_eq!(view["length"], json!(36), "three positions of twelve bytes");
    assert!(
        primitive["indices"].is_u64(),
        "the index list is laid out too"
    );
    // A primitive that declares no material wears the glTF default one, which is an entry like
    // any other: the document names a rank, never an absence.
    assert_eq!(primitive["material"], json!(0));
    assert_eq!(
        tables["materials"][0]["metalness"],
        json!(1.0),
        "the glTF default"
    );
    // The autonomous copy is laid out beside it, one degenerate triangle per primitive, and wears
    // the variant without tangents it publishes.
    let autonomous = &tables["documents"]["scene.gltf"];
    assert_eq!(autonomous["buffer"], json!("scene.bin"));
    assert_eq!(
        autonomous["meshes"][0]["primitives"][0]["attributes"],
        json!({"POSITION":0})
    );
}

#[test]
fn the_tables_describe_the_published_scene_and_not_the_input() {
    // The slice keeps one node of the two and renumbers what it keeps: the tables follow the
    // document the runtime draws, so a node left out of the slice is absent from them.
    let (_root, mut options) = fixture();
    let mut gltf = read_gltf(&options);
    with_bounds(&mut gltf);
    gltf["meshes"] = json!([{"primitives":[]}, gltf["meshes"][0]]);
    gltf["nodes"] = json!([{"mesh":1},{"mesh":1}]);
    write_gltf(&options, &gltf, None);
    options.triangle_budget = 1;
    let tables = tables_of(&options);
    // The node left out keeps its place in the graph and draws nothing.
    assert_eq!(
        tables["nodes"][0]["mesh"],
        json!(0),
        "the rank the published scene uses"
    );
    assert_eq!(tables["nodes"][1]["mesh"], Value::Null, "{tables}");
    assert_eq!(
        tables["documents"]["source.gltf"]["meshes"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "one mesh fits the slice"
    );
}

#[test]
fn the_format_number_is_raised_and_an_earlier_cache_is_refused_by_it() {
    let (_root, options) = fixture();
    let (first, _) = compile_with_events(&options);
    assert_eq!(first["formatVersion"], json!(FORMAT_VERSION));
    assert_eq!(
        FORMAT_VERSION, 9,
        "the batch that pages the manifest raises it"
    );
    let path = options
        .key_directory(first["key"].as_str().expect("key"))
        .join("clusters.json");
    let mut manifest = read_json(&path);
    manifest["formatVersion"] = json!(3);
    fs::write(&path, serde_json::to_vec(&manifest).expect("encode")).expect("tamper");
    let (_second, events) = compile_with_events(&options);
    assert_eq!(
        events[0]["reason"],
        "manifest format 3 is not one this compiler writes"
    );
}
