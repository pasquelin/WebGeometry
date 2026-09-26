//! Common harness of golden fixtures: compile a scene shipped with the package
//! into a throwaway cache, then reread everything a golden compares — the output
//! of `compile`, the slim manifest and the binary sidecars. Each golden family
//! adds its own digest there, never its own harness: two ways to compile a
//! fixture are two truths.
use super::*;
use std::{sync::atomic::AtomicU64, time::SystemTime, time::UNIX_EPOCH};

/// Throwaway root rank: the macOS clock stops at the microsecond, two parallel goldens do not.
static NEXT: AtomicU64 = AtomicU64::new(0);

/// A compiled golden fixture. The throwaway cache is erased with the structure,
/// including when the assertion that follows fails and takes the test with it.
pub(super) struct GoldenRun {
    pub result: Value,
    pub slim: Value,
    /// The sidecar of the mesh page, and the head's: the texture previews.
    pub binary: Vec<u8>,
    pub previews: Vec<u8>,
    /// What compilation published along the way: a driver's step is proven in its report.
    pub reports: Vec<Value>,
    /// Throwaway cache: a driver's intermediate scene and products published by the compiler.
    pub(super) cache: PathBuf,
    root: PathBuf,
}
impl Drop for GoldenRun {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Folder of a golden fixture, named by its path under `tests/fixtures/formats/`.
pub(crate) fn golden_dir(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures/formats")
        .join(relative)
}

/// Compiles `<dir>/<name>.gltf`: the golden of a scene delivered as-is.
pub(super) fn compile_golden(dir: &Path, name: &str) -> GoldenRun {
    compile_golden_source(&dir.join(format!("{name}.gltf")), name)
}

/// Compiles any source — a file of a format a driver claims, or a folder — with
/// the same options for every golden: one thread and no simplification, so the
/// output depends only on the scene. A driver's golden therefore enters through
/// the router, like any compiler caller, and knows no more than it which format
/// it is given.
pub(super) fn compile_golden_source(source: &Path, name: &str) -> GoldenRun {
    let (options, root) = golden_options(source, name);
    let reports = std::sync::Mutex::new(Vec::new());
    let result = compile(&options, |report| {
        reports.lock().expect("reports").push(report);
    })
    .unwrap_or_else(|e| panic!("{name}: compile: {e}"));
    let paged = paged(&options.key_directory(result["key"].as_str().expect("key")));
    let [previews, binary] = <[Vec<u8>; 2]>::try_from(paged.sidecars).expect("head and one mesh");
    GoldenRun {
        result,
        slim: paged.manifest,
        binary,
        previews,
        reports: reports.into_inner().expect("reports"),
        cache: options.cache.clone(),
        root,
    }
}

/// Refusal code of a source the compiler does not accept, with the same options
/// as a golden: what a driver refuses is fixed like what it produces, and by the
/// same path.
pub(super) fn refused_golden_source(source: &Path, name: &str) -> String {
    let (options, root) = golden_options(source, name);
    let refusal = compile(&options, |_| {})
        .err()
        .unwrap_or_else(|| panic!("{name}: this source had to be refused"));
    let _ = fs::remove_dir_all(&root);
    refusal.code.to_string()
}

/// Common options, and the throwaway root that carries them; the compute bench compiles
/// its fixtures with them too.
pub(crate) fn golden_options(source: &Path, name: &str) -> (Options, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "trillion3d-golden-{name}-{}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos(),
    ));
    let options = Options {
        source: source.to_path_buf(),
        cache: root.join("cache"),
        resource_base: "/assets".into(),
        scope: "full".into(),
        triangle_budget: 1_000_000,
        threads: 1,
        ram_budget_mb: 64,
        simplification: "none".into(),
        texture_formats: vec![crate::texture_preview::BlockFormat::Bc7],
        cancelled: Arc::new(AtomicBool::new(false)),
    };
    (options, root)
}

impl GoldenRun {
    /// Intermediate scene a named driver wrote in the cache: its manifest and glTF.
    pub(super) fn prepared(&self, plugin: &str) -> (Value, Value) {
        let directory = self.prepared_dir(plugin);
        let manifest = fs::read(directory.join("manifest.json")).expect("manifest.json");
        let gltf = fs::read(directory.join("model.gltf")).expect("model.gltf");
        (
            serde_json::from_slice(&manifest).expect("manifest.json is valid JSON"),
            serde_json::from_slice(&gltf).expect("model.gltf is valid JSON"),
        )
    }

    /// Cache folder where a named driver wrote its intermediate scene.
    pub(super) fn prepared_dir(&self, plugin: &str) -> PathBuf {
        let imports = self.cache.join("native").join("imports");
        let entries = fs::read_dir(&imports).expect("imports directory");
        for entry in entries.flatten() {
            let manifest: Value = match fs::read(entry.path().join("manifest.json"))
                .map(|bytes| serde_json::from_slice(&bytes).expect("manifest.json is valid JSON"))
            {
                Ok(manifest) => manifest,
                Err(_) => continue,
            };
            if manifest
                .pointer("/source/plugin/name")
                .and_then(Value::as_str)
                == Some(plugin)
            {
                return entry.path();
            }
        }
        panic!("no intermediate scene written by driver {plugin}");
    }
}

/// What every scene-driver golden fixes, whichever the format: driver provenance,
/// what it counted and refused, the intermediate scene frame it wrote, and the two
/// numbers the compiler kept of it. Each family then adds what is its own.
pub(super) fn scene_digest(run: &GoldenRun, plugin: &str) -> (Value, Value, Value) {
    let (manifest, gltf) = run.prepared(plugin);
    let digest = json!({
      "formatVersion": run.result["formatVersion"],
      "plugin": manifest["source"]["plugin"],
      "counts": manifest["source"]["counts"],
      "unsupported": manifest["unsupported"],
      "notes": manifest["notes"],
      "meshNodes": manifest["runtime"]["meshNodes"],
      "trianglesAcrossNodes": manifest["runtime"]["trianglesAcrossNodes"],
      "roots": gltf["scenes"][0]["nodes"],
      "nodes": gltf["nodes"],
      "meshNames": gltf["meshes"].as_array().expect("meshes").iter()
                       .map(|mesh| mesh["name"].clone()).collect::<Vec<Value>>(),
      "compiled": {
        "selectedTriangles": run.result["selectedTriangles"],
        "totalNodes": run.result["totalNodes"],
      },
    });
    (digest, manifest, gltf)
}

/// Versioned expected of a fixture, without the two fields that are only prose.
pub(super) fn golden_expected(dir: &Path) -> Value {
    let mut expected: Value =
        serde_json::from_slice(&fs::read(dir.join("expected.json")).expect("expected.json"))
            .expect("expected.json is not valid JSON");
    if let Some(object) = expected.as_object_mut() {
        object.remove("case");
        object.remove("rule");
    }
    expected
}

/// Writes the expected of a fixture that regenerates: the digest the golden will
/// compare, plus the two prose fields `golden_expected` then strips. Those are
/// kept as they were when the file existed; given values serve only first write.
pub(super) fn write_expected(dir: &Path, mut expected: Value, case: &str, rule: &str) {
    let previous: Option<Value> = fs::read(dir.join("expected.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let object = expected.as_object_mut().expect("expected");
    for (field, fallback) in [("case", case), ("rule", rule)] {
        let kept = previous
            .as_ref()
            .and_then(|value| value.get(field))
            .cloned()
            .unwrap_or_else(|| json!(fallback));
        object.insert(field.into(), kept);
    }
    let text = serde_json::to_vec_pretty(&expected).expect("expected");
    fs::write(dir.join("expected.json"), &text).expect("expected.json");
    println!("fixture written to {}", dir.display());
}
