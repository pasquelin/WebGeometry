//! Proof that a cached folder is whole before `compiler_reuse.rs` keeps it: every product of the
//! folder against the fingerprint the manifest recorded, every cell against the record its tables'
//! pages hold, every page and sidecar of the manifest against its slot, every object it names against its
//! content-addressed name, every baked texture level it names by its presence.
use super::*;
use compiler_manifest_pages::{read_manifest, Paged};
use compiler_reuse::{Check, Reused};

/// The folder under `key`, checked head to objects. The first failed check names
/// the reason and stops the proof: the job then recompiles.
pub(super) fn prove(
    o: &Options,
    key: &str,
    directory: &Path,
    head: &[u8],
    pool: &rayon::ThreadPool,
) -> Check<Reused> {
    let root: Value = serde_json::from_slice(head).map_err(|e| format!("manifest: {e}"))?;
    // The root first: a folder of another job or format is refused before a page is read.
    let format = check_head(&root, key, &o.scope)?;
    // The answer sheet is a product of every compilation, at the cache root: a
    // host reads "nothing to answer" in its absence, so a folder without it is not whole.
    if !o.cache.join(cutout::DECISIONS_FILE).is_file() {
        return Err("cutout answer sheet is missing".into());
    }
    // Objects live in the sidecar columns alone, each sidecar proven as its page is read, and
    // read once: the digests and levels proven are what prune keeps.
    let Paged { manifest, sidecars } = read_manifest(directory, &root)?;
    let (mut objects, mut levels) = (BTreeSet::new(), Vec::new());
    for sidecar in &sidecars {
        objects.extend(manifest_binary::digests(sidecar).map_err(|e| e.message)?);
        levels.extend(manifest_binary::texture_levels(sidecar).map_err(|e| e.message)?);
    }
    let record = manifest[compiler_publish::FILES_FIELD].as_object().cloned();
    let mut files = compiler_tables::cell_records(directory)?; // The manifest's records win.
    files.extend(record.ok_or("manifest records no files")?);
    let mut items = record_items(directory, &files)?;
    let files = items.len();
    items.extend(objects.iter().map(|digest| Item {
        path: object_path(o, digest),
        sha256: digest.clone(),
        bytes: None,
        what: format!("object {digest}"),
    }));
    let sizes = prove_all(o, pool, &items)?;
    let (file_bytes, object_bytes) = sizes.split_at(files);
    let native = o.cache.join("native");
    let texture_levels = check_textures(&native, &manifest, &levels)?;
    let textures = levels.into_iter().map(|level| level.sha256).collect();
    Ok(Reused {
        report: json!({"files":files,"fileBytes":file_bytes.iter().sum::<u64>(),"objects":objects.len(),"objectBytes":object_bytes.iter().sum::<u64>(),"textureLevels":texture_levels}),
        keep: Keep { objects, textures },
        manifest,
        format,
    })
}

/// The head of the manifest says whose product it is: this key, this scope, this
/// compiler, a format this compiler writes — returned, for the pointer. Anything
/// else under the key is a folder written by hand or by another build, never reused.
fn check_head(manifest: &Value, key: &str, scope: &str) -> Check<u32> {
    let expected = [
        ("status", json!("ready")),
        ("key", json!(key)),
        ("scope", json!(scope)),
        ("compilerVersion", json!(COMPILER_VERSION)),
    ];
    if let Some((field, _)) = expected
        .iter()
        .find(|(field, value)| manifest[*field] != *value)
    {
        return Err(format!("manifest {field} is not this job's"));
    }
    let format = manifest["formatVersion"].as_u64().unwrap_or(0) as u32;
    if ![FORMAT_VERSION, CLUSTERED_BLEND_FORMAT_VERSION].contains(&format) {
        return Err(format!(
            "manifest format {format} is not one this compiler writes"
        ));
    }
    Ok(format)
}

/// One file to prove: where it is, what it must hash to, its recorded size when
/// the record has one, and how the reason names it.
struct Item {
    path: PathBuf,
    sha256: String,
    bytes: Option<u64>,
    what: String,
}

/// Every product recorded, by name, fingerprint and size. A missing record is
/// a folder written before records existed, or by hand: not proven. A name is
/// checked before it forms a path.
fn record_items(directory: &Path, files: &serde_json::Map<String, Value>) -> Check<Vec<Item>> {
    files
        .iter()
        .map(|(name, expected)| {
            if !is_safe_source_name(name) {
                return Err(format!("file record names {name:?}"));
            }
            let (Some(sha256), Some(bytes)) =
                (expected["sha256"].as_str(), expected["bytes"].as_u64())
            else {
                return Err(format!("file record of {name} has no fingerprint or size"));
            };
            Ok(Item {
                path: directory.join(name),
                sha256: sha256.to_string(),
                bytes: Some(bytes),
                what: name.clone(),
            })
        })
        .collect()
}

/// One file against its fingerprint and, when recorded, its size, in a single
/// read pass. Returns the size read.
fn proven(o: &Options, item: &Item) -> Check<u64> {
    check(o).map_err(|e| e.message)?;
    let Item {
        path,
        sha256,
        bytes,
        what,
    } = item;
    let (found, size) = hash_file_sized(path).map_err(|e| format!("{what}: {e}"))?;
    if bytes.is_some_and(|expected| expected != size) {
        return Err(format!(
            "{what} is {size} bytes, not what the manifest recorded"
        ));
    }
    if found != *sha256 {
        return Err(format!("{what} does not match its fingerprint"));
    }
    Ok(size)
}

/// Every item side by side on the job's pool, once for files and objects alike:
/// the same check the compile path applies before it reuses an object
/// (`compiler_page_object.rs`). Returns the sizes, in item order.
fn prove_all(o: &Options, pool: &rayon::ThreadPool, items: &[Item]) -> Check<Vec<u64>> {
    pool.install(|| {
        items
            .par_iter()
            .map(|item| proven(o, item))
            .collect::<Check<_>>()
    })
}

/// Every baked level the sidecar names, by presence: the compile path trusts a
/// level file by its name too — the source-image fingerprint and the atlas say
/// what it holds. A bake the compile could not finish — a level that failed to
/// write leaves `baked` under `first`, and the report says so — is not proven: the
/// compile path would bake it again, the reuse never would. Several textures
/// read one image, so a level file is counted once. Returns the files found.
pub(super) fn check_textures(
    native: &Path,
    manifest: &Value,
    levels: &[manifest_binary::BakedLevels],
) -> Check<usize> {
    if !manifest["texturePreviews"]["notes"][texture_preview::LEVEL_WRITE_FAILED].is_null() {
        return Err("a texture level failed to write when the folder was compiled".into());
    }
    let mut files = BTreeSet::new();
    for entry in levels {
        let kind = texture_preview::AtlasKind::from_word(entry.kind)
            .ok_or(format!("sidecar names atlas {}", entry.kind))?;
        if entry.baked < entry.first {
            return Err(format!("texture {} was not fully baked", entry.sha256));
        }
        let mut formats = vec![texture_preview::LOSSLESS];
        for (family, word) in texture_preview::BlockFormat::ALL.iter().zip(entry.layouts) {
            match texture_preview::Layout::from_word(word) {
                Some(Some(layout)) => formats.push(family.file_name(layout)),
                Some(None) => {}
                None => return Err(format!("sidecar names layout {word}")),
            }
        }
        for level in 0..entry.baked {
            for format in &formats {
                files.insert(texture_preview::level_path(
                    &entry.sha256,
                    kind,
                    level,
                    format,
                ));
            }
        }
    }
    for file in &files {
        if !native.join(file).is_file() {
            return Err(format!("texture level {file} is missing"));
        }
    }
    Ok(files.len())
}
