//! #823 — nested and instanced glTF nodes, and a child light, cook at their world placement.
//!
//! The committed `tests/fixtures/formats/gltf-world/` (its README says what it holds) nests a mesh
//! and a point light under a moved, turned and scaled parent, and draws a second mesh twice through
//! `EXT_mesh_gpu_instancing`. The expected positions are written here by hand from the file's
//! numbers, never computed by the compiler's own walk.
use super::*;
use crate::compiler_world::{transform_point, world_matrices};

type Triangle = [[f64; 3]; 3];

/// The fixture triangle's corners, as `world.bin` stores them.
const CORNERS: Triangle = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

/// The triangles the file places in the world: `house` maps `(x,y,z)` to `(10+2z, 2y, -2x)`.
const EXPECTED: [Triangle; 3] = [
    // `wall`: the triangle moved by (1,0,0).
    [[10.0, 0.0, -2.0], [10.0, 0.0, -4.0], [10.0, 2.0, -2.0]],
    // `wing`'s first instance: moved by (1,0,0), then by the node's (0,0,3).
    [[16.0, 0.0, -2.0], [16.0, 0.0, -4.0], [16.0, 2.0, -2.0]],
    // Its second: scaled by 3, a quarter turn about Z, moved by (0,2,0), then by (0,0,3).
    [[16.0, 4.0, 0.0], [16.0, 10.0, 0.0], [16.0, 4.0, 6.0]],
];

/// `lamp`: (0,1,0) under `wall`, so (1,1,0) in `house`'s frame.
const LAMP: [f64; 3] = [10.0, 2.0, -2.0];

fn close(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
}

/// The committed fixture: its document and its binary.
fn committed() -> (Value, Vec<u8>) {
    let folder =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/formats/gltf-world");
    let bin = fs::read(folder.join("world.bin")).expect("bin");
    (read_json(&folder.join("world.gltf")), bin)
}

#[test]
fn nested_and_instanced_nodes_cook_at_their_world_placement() {
    let (document, bin) = committed();
    let (_root, options) = gltf_fixture("world", &document, &bin);
    let result = compile(&options, |_| {}).expect("compile");
    let directory = options.key_directory(result["key"].as_str().expect("key"));

    // Meshes: the node table the runtime reads, composed into world matrices.
    // The table writes an absent field as `null`, which a glTF node leaves out.
    let tables = read_json(&directory.join("scene-tables.json"));
    let nodes: Vec<Value> = tables["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .map(|node| {
            let mut node = node.as_object().expect("node").clone();
            node.retain(|_, value| !value.is_null());
            Value::Object(node)
        })
        .collect();
    let worlds = world_matrices(&json!({ "nodes": nodes })).expect("world");
    let mut drawn: Vec<Triangle> = (0..nodes.len())
        .filter(|id| nodes[*id].get("mesh").is_some())
        .map(|id| CORNERS.map(|corner| transform_point(&worlds[id], corner)))
        .collect();
    drawn.sort_by(|a, b| a[0].partial_cmp(&b[0]).expect("finite"));
    assert_eq!(
        drawn.len(),
        EXPECTED.len(),
        "one mesh node per instance: {drawn:?}"
    );
    for (cooked, expected) in drawn.iter().zip(&EXPECTED) {
        let cooked = cooked.as_flattened();
        assert!(
            close(cooked, expected.as_flattened()),
            "{cooked:?} != {expected:?}"
        );
    }

    // The light: `lights.json`, in world space.
    let lights = read_json(&directory.join("lights.json"));
    let position: Vec<f64> = lights["lights"][0]["position"]
        .as_array()
        .expect("position")
        .iter()
        .filter_map(Value::as_f64)
        .collect();
    assert!(close(&position, &LAMP), "lamp at {position:?}");
}

#[test]
fn instance_attributes_of_different_counts_are_refused() {
    let (mut document, bin) = committed();
    // One scale for two translations: the instances cannot be told apart.
    document["accessors"][4]["count"] = json!(1);
    let (_root, options) = gltf_fixture("world", &document, &bin);
    let error = compile(&options, |_| {}).expect_err("mismatched instance counts");
    assert_eq!(error.code, "INVALID_GLTF", "{error:?}");
}
