use super::*;

#[test]
fn obj_source_is_imported_into_the_cache_then_compiled() {
    let (root, options) = obj_fixture("quad.obj", true);
    let events = std::sync::Mutex::new(Vec::new());
    let result = compile(&options, |e| events.lock().unwrap().push(e)).expect("compile obj");
    assert_eq!(result["selectedTriangles"], 2);
    let imports = options.cache.join("native/imports");
    let entries: Vec<_> = fs::read_dir(&imports)
        .expect("imports")
        .map(|e| e.expect("entry").path())
        .collect();
    assert_eq!(entries.len(), 1);
    let manifest: Value =
        serde_json::from_slice(&fs::read(entries[0].join("manifest.json")).expect("manifest"))
            .expect("json");
    assert_eq!(manifest["status"], "ready");
    assert_eq!(manifest["source"]["plugin"]["name"], "obj");
    assert_eq!(result["scenePlugin"]["name"], "obj");
    assert_eq!(manifest["runtime"]["trianglesAcrossNodes"], 2);
    assert_eq!(manifest["runtime"]["meshNodes"], 1);
    let gltf: Value =
        serde_json::from_slice(&fs::read(entries[0].join("model.gltf")).expect("gltf"))
            .expect("json");
    assert_eq!(
        gltf["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"][3],
        0.5
    );
    assert_eq!(gltf["materials"][0]["alphaMode"], "BLEND");
    assert_eq!(gltf["images"][0]["uri"], "textures/paint.png");
    assert!(
        gltf["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"]
            .as_u64()
            .is_some()
    );
    let steps = import_steps(&events);
    assert!(steps.contains(&"complete".to_string()), "{steps:?}");
    // A second run reuses the import and only recompiles when the compile key changed (it did not).
    let events = std::sync::Mutex::new(Vec::new());
    let again = compile(&options, |e| events.lock().unwrap().push(e)).expect("compile again");
    assert_eq!(again["key"], result["key"]);
    let steps = import_steps(&events);
    assert_eq!(steps, vec!["reused".to_string()]);
    fs::remove_dir_all(root).expect("cleanup");
}
#[test]
fn directory_of_importable_files_is_merged_into_one_scene() {
    let (root, options) = obj_fixture("a.obj", false);
    let dir = options.source.parent().expect("dir").to_path_buf();
    fs::copy(dir.join("a.obj"), dir.join("b.obj")).expect("copy");
    let options = Options {
        source: dir.clone(),
        ..options
    };
    assert!(matches!(plugins::scene::route(&dir).expect("route"),
            plugins::scene::Routed::Driver(plugin, ref files) if plugin.name() == "obj" && files.len() == 2));
    let result = compile(&options, |_| {}).expect("compile dir");
    assert_eq!(result["selectedTriangles"], 4);
    assert_eq!(result["selectedNodes"], 2);
    fs::remove_dir_all(root).expect("cleanup");
}
#[test]
fn recompiling_prunes_stale_keys_and_orphan_objects() {
    let (root, options) = obj_fixture("quad.obj", false);
    let first = compile(&options, |_| {}).expect("first");
    let other = Options {
        simplification: "qem-endpoints".into(),
        ..options.clone()
    };
    let second = compile(&other, |_| {}).expect("second");
    assert_ne!(first["key"], second["key"]);
    let keys: Vec<_> = fs::read_dir(options.cache.join("native/full"))
        .expect("scope")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .collect();
    assert_eq!(keys.len(), 1, "only the latest key survives");
    let mut referenced = BTreeSet::new();
    for p in second["primitives"].as_array().unwrap() {
        for page in p["pages"].as_array().unwrap() {
            referenced.insert(page["sha256"].as_str().unwrap().to_string());
            if let Some(g) = page["geometry"]["sha256"].as_str() {
                referenced.insert(g.to_string());
            }
        }
    }
    let objects: BTreeSet<String> = fs::read_dir(options.cache.join("native/objects"))
        .expect("objects")
        .filter_map(|e| e.ok())
        .map(|e| {
            e.file_name()
                .to_string_lossy()
                .trim_end_matches(".bin")
                .to_string()
        })
        .collect();
    assert!(
        referenced.is_subset(&objects),
        "every page of the surviving manifest is still on disk"
    );
    assert!(
        objects.len()
            <= referenced.len() + second["bundles"].as_array().map(|b| b.len()).unwrap_or(4),
        "orphans of the first key are gone: {} objects for {} pages",
        objects.len(),
        referenced.len()
    );
    // The pointer still resolves after pruning.
    let pointer: Value =
        serde_json::from_slice(&fs::read(options.cache.join("native/full/manifest.json")).unwrap())
            .unwrap();
    assert!(options
        .cache
        .join("native/full")
        .join(pointer["url"].as_str().unwrap())
        .exists());
    fs::remove_dir_all(root).expect("cleanup");
}
#[test]
fn pruning_one_scope_keeps_the_objects_the_other_scope_needs() {
    let (root, options, full) = two_mesh_folder();
    assert_eq!(full["selectedTriangles"], 3);
    let slice = Options {
        scope: "slice".into(),
        triangle_budget: 1,
        ..options.clone()
    };
    compile(&slice, |_| {}).expect("slice");
    // Every object the full manifest names must have survived the slice compile's pruning.
    let key = full["key"].as_str().unwrap();
    let dir = options.cache.join("native/full").join(key);
    assert!(dir.join("clusters.json").exists());
    let mut digests = BTreeSet::new();
    for bin in paged(&dir).sidecars {
        referenced_objects(&json!({}), Some(&bin), &mut digests)
            .expect("digests of the full scope");
    }
    assert!(!digests.is_empty(), "binary columns carry the page digests");
    for digest in &digests {
        assert!(
            options
                .cache
                .join("native/objects")
                .join(format!("{digest}.bin"))
                .exists(),
            "object {digest} of the full scope was pruned by the slice compile"
        );
    }
    fs::remove_dir_all(root).expect("cleanup");
}
#[test]
fn gltf_sources_never_go_through_the_importer() {
    let (root, options) = fixture();
    assert!(matches!(
        plugins::scene::route(&options.source).expect("manifest dir"),
        plugins::scene::Routed::Manifest
    ));
    assert!(matches!(
        plugins::scene::route(&options.source.join("mesh.gltf")).expect("gltf file"),
        plugins::scene::Routed::Driver(plugin, _) if plugin.name() == "gltf"
    ));
    fs::remove_dir_all(root).expect("cleanup");
}
