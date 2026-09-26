use super::*;

#[test]
fn cancelled_import_reports_cancelled() {
    let (root, options) = obj_fixture("quad.obj", false);
    options.cancelled.store(true, Ordering::Relaxed);
    assert_eq!(
        compile(&options, |_| {}).expect_err("cancelled").code,
        "CANCELLED"
    );
    fs::remove_dir_all(root).expect("cleanup");
}

fn objects_on_disk(cache: &Path) -> BTreeSet<String> {
    fs::read_dir(cache.join("native/objects"))
        .expect("objects")
        .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
        .collect()
}
/// The scope that is not recompiled names its pages in its sidecar columns. If that
/// sidecar carries another binary version, prune must neither read it as "no object
/// referenced" nor delete anything: it fails and leaves the cache intact.
#[test]
fn a_sidecar_of_another_version_stops_the_prune_without_removing_anything() {
    let (root, options, full) = two_mesh_folder();
    let directory = options
        .cache
        .join("native/full")
        .join(full["key"].as_str().expect("key"));
    let mut bytes = paged(&directory).sidecars.remove(1);
    let sidecar = directory.join(crate::compiler_manifest_pages::sidecar_file(&hash(&bytes)));
    bytes[4..8].copy_from_slice(&(manifest_binary::MANIFEST_BINARY_VERSION - 1).to_le_bytes());
    fs::write(&sidecar, &bytes).expect("older version");
    let before = objects_on_disk(&options.cache);
    let slice = Options {
        scope: "slice".into(),
        triangle_budget: 1,
        ..options.clone()
    };
    let error = compile(&slice, |_| {}).expect_err("the prune refuses an unreadable sidecar");
    assert_eq!(error.code, "UNSUPPORTED_FORMAT", "{error}");
    assert_eq!(
        objects_on_disk(&options.cache),
        before,
        "an incompatible sidecar removes nothing"
    );
    fs::remove_dir_all(root).expect("cleanup");
}
