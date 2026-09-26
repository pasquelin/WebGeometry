use super::*;
use compiler_manifest_pages::Paged;

pub(super) fn referenced_objects(
    json: &Value,
    binary: Option<&[u8]>,
    into: &mut BTreeSet<String>,
) -> Result<()> {
    fn walk(value: &Value, into: &mut BTreeSet<String>) {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    if k == "sha256" {
                        if let Some(s) = v.as_str() {
                            if s.len() == 64 {
                                into.insert(s.to_string());
                            }
                        }
                    } else {
                        walk(v, into);
                    }
                }
            }
            Value::Array(items) => {
                for v in items {
                    walk(v, into);
                }
            }
            _ => {}
        }
    }
    walk(json, into);
    if let Some(bytes) = binary {
        // A sidecar of another version lays out its columns differently: reading it
        // as "no object referenced" would delete pages still in use, so an unknown
        // format is refused.
        into.extend(manifest_binary::digests(bytes).map_err(unreadable)?);
    }
    Ok(())
}
/// A sidecar this compiler cannot read: prune stops on it, cache intact.
fn unreadable(e: impl Display) -> CompilerError {
    CompilerError::new(
        "UNSUPPORTED_FORMAT",
        format!("Cached manifest binary is not readable by this compiler: {e}"),
    )
}
/// What the key just published or proved still needs: its objects and the source
/// images whose baked levels it reads. Everything else of the cache may go.
pub(super) struct Keep {
    pub objects: BTreeSet<String>,
    pub textures: BTreeSet<String>,
}
impl Keep {
    /// What a result just published names: its objects, and the images its previews read.
    pub fn of_result(result: &Value, previews: &[texture_preview::TexturePreview]) -> Result<Self> {
        let mut objects = BTreeSet::new();
        referenced_objects(result, None, &mut objects)?;
        let textures = previews.iter().map(|p| p.sha256.clone()).collect();
        Ok(Self { objects, textures })
    }
    /// What a published manifest and its sidecars name, for a scope this job does
    /// not touch: pages and texture levels live only in the sidecar columns, read
    /// once for both.
    pub fn named_by(paged: &Paged) -> Result<Self> {
        let (mut objects, mut textures) = (BTreeSet::new(), BTreeSet::new());
        referenced_objects(&paged.manifest, None, &mut objects)?;
        for sidecar in &paged.sidecars {
            objects.extend(manifest_binary::digests(sidecar).map_err(unreadable)?);
            textures.extend(manifest_binary::texture_digests(sidecar).map_err(unreadable)?);
        }
        Ok(Self { objects, textures })
    }
}
/// Objects and image fingerprints named by a scope that is not recompiled. Without
/// a readable manifest, prune cannot decide what to keep, so it fails and deletes
/// nothing rather than counting that scope as zero objects.
fn other_scope(dir: &Path, keep: &mut Keep) -> Result<()> {
    if !dir.join(MANIFEST_FILE).is_file() {
        return Ok(());
    }
    let paged = compiler_manifest_pages::read_manifest_at(dir)
        .map_err(|e| unreadable(format!("{}: {e}", dir.display())))?;
    let named = Keep::named_by(&paged)?;
    keep.objects.extend(named.objects);
    keep.textures.extend(named.textures);
    Ok(())
}

/// After a successful compile, remove the other keys of this scope and every object no surviving
/// manifest references. Objects are shared across scopes, so the other scope's manifest is read too.
/// Hosts therefore never need to wipe a cache before recompiling: the cache converges on its own.
pub(super) fn prune_cache(
    o: &Options,
    key: &str,
    mut keep: Keep,
    progress: &(impl Fn(Value) + Sync),
) -> Result<Value> {
    let native = o.cache.join("native");
    let mut removed_keys = 0usize;
    for scope in ["slice", "full"] {
        let dir = native.join(scope);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        // Each scope keeps exactly the key its pointer names; for this scope that is the key just written.
        let current = if scope == o.scope {
            Some(key.to_string())
        } else {
            fs::read(dir.join("manifest.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .and_then(|p| p["key"].as_str().map(str::to_owned))
        };
        // The other scope is read before any deletion: a missing sidecar or one of
        // another version stops prune, cache intact, instead of erasing pages it
        // still uses.
        if scope != o.scope {
            if let Some(name) = current.as_deref() {
                other_scope(&dir.join(name), &mut keep)?;
            }
        }
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if current.as_deref() != Some(name) {
                fs::remove_dir_all(entry.path())?;
                removed_keys += 1;
            }
        }
    }
    // Stale FBX/OBJ imports: keep the one this compile read, drop the others.
    let imports = native.join("imports");
    if o.source.starts_with(&imports) {
        if let Ok(entries) = fs::read_dir(&imports) {
            for entry in entries {
                let entry = entry?;
                if entry.file_type()?.is_dir() && entry.path() != o.source {
                    fs::remove_dir_all(entry.path())?;
                    removed_keys += 1;
                }
            }
        }
    }
    let mut removed_objects = 0usize;
    let mut removed_bytes = 0u64;
    let mut kept_objects = 0usize;
    if let Ok(entries) = fs::read_dir(native.join("objects")) {
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let digest = name.trim_end_matches(".bin");
            if keep.objects.contains(digest) {
                kept_objects += 1;
            } else {
                removed_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                fs::remove_file(entry.path())?;
                removed_objects += 1;
            }
        }
    }
    let (removed_textures, texture_bytes) =
        compiler_prune_textures::prune_textures(&native, &keep.textures)?;
    let summary = json!({"removedKeys":removed_keys,"removedObjects":removed_objects,"removedBytes":removed_bytes,"keptObjects":kept_objects,
        "removedTextures":removed_textures,"removedTextureBytes":texture_bytes});
    if removed_keys > 0 || removed_objects > 0 || removed_textures > 0 {
        progress(
            json!({"phase":"prune","completed":1,"total":1,"removedKeys":removed_keys,"removedObjects":removed_objects,"removedBytes":removed_bytes,
            "removedTextures":removed_textures,"removedTextureBytes":texture_bytes}),
        );
    }
    Ok(summary)
}
