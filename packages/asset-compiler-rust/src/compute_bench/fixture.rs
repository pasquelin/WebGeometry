//! Byte-by-byte fingerprint of everything the compiler writes. The same file is
//! produced before and after the optimisations; two identical runs have exactly
//! the same fingerprints.
use super::report::{measures_dir, today};
use crate::compile;
use crate::compiler_validate::hash;
use crate::tests::golden::{golden_dir, golden_options};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Instant;

const NAMES: [&str; 5] = [
    "three-stack",
    "full-overlap",
    "partial-overlap",
    "masked-overlay",
    "blend-overlay",
];

/// Relative path and fingerprint of every file in the folder, sorted: the comparison is total.
fn digests(root: &Path, base: &Path, into: &mut Vec<(String, String)>) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            digests(root, &path, into);
        } else if let Ok(bytes) = std::fs::read(&path) {
            let name = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();
            into.push((name, hash(&bytes)));
        }
    }
}

/// The slim manifest without what depends on the machine or the code version: what
/// remains must be bit-identical from one version to the next.
fn stable(mut manifest: Value) -> Value {
    if let Some(object) = manifest.as_object_mut() {
        object.remove("metrics");
        object.remove("key");
    }
    manifest
}

fn compile_one(name: &str) -> (f64, Value) {
    let dir = golden_dir("coplanar").join(name);
    let (options, root) = golden_options(&dir.join(format!("{name}.gltf")), name);
    let started = Instant::now();
    let result = compile(&options, |_| {}).unwrap_or_else(|e| panic!("{name} : {e}"));
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    let key = result["key"].as_str().expect("key").to_string();
    let directory = options.cache.join("native").join("full").join(&key);
    let mut files: Vec<(String, String)> = Vec::new();
    digests(&directory, &directory, &mut files);
    let mut objects: Vec<(String, String)> = Vec::new();
    let store = options.cache.join("native").join("objects");
    digests(&store, &store, &mut objects);
    let slim = crate::compiler_manifest_pages::read_manifest_at(&directory);
    let slim = slim.expect("the manifest's pages").manifest;
    // Phases belong to the job that spent them: the survey carries them per fixture,
    // since no counter adds them up from one compilation to another.
    let record = json!({"fixture":name,"ms":ms,"phasesMs":result["metrics"]["phaseElapsedMs"],
      "manifesteAllege":hash(serde_json::to_vec(&stable(slim)).expect("manifest").as_slice()),
      "fichiers":files.iter().map(|(n,d)|json!([n,d])).collect::<Vec<Value>>(),
      "objets":objects.iter().map(|(_,d)|json!(d)).collect::<Vec<Value>>()});
    let _ = std::fs::remove_dir_all(&root);
    (ms, record)
}

/// Compiles the five fixtures and writes the survey to `.mesure/out/calculs/`.
pub(crate) fn run() -> (f64, String) {
    let label = std::env::var("TRILLION3D_BANC_LABEL").unwrap_or_else(|_| "banc".into());
    let mut total = 0.0;
    let mut records = Vec::new();
    for name in NAMES {
        let (ms, record) = compile_one(name);
        total += ms;
        records.push(record);
    }
    let path = measures_dir().join(format!("calculs-natif-{}-fixtures-{label}.json", today()));
    let payload = json!({"label":label,"totalMs":total,"fixtures":records});
    let _ = std::fs::write(
        &path,
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
    (total, path.to_string_lossy().to_string())
}
