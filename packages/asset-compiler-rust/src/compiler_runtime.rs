use super::*;

pub fn runtime_manifest(
    file: &str,
    sha256: &str,
    sidecars: &[(String, String)],
    mesh_nodes: usize,
    triangles: usize,
) -> Value {
    let sidecars: Vec<Value> = sidecars
        .iter()
        .map(|(file, sha)| json!({"file":file,"sha256":sha}))
        .collect();
    json!({"status":"ready","formatVersion":SOURCE_FORMAT_VERSION,"runtime":{"file":file,"sha256":sha256,"sidecars":sidecars,"trianglesAcrossNodes":triangles,"meshNodes":mesh_nodes}})
}
pub(super) fn load_model_file(
    dir: &Path,
    name: &str,
    declared: Option<(Value, Vec<u8>)>,
) -> Result<RuntimeSource> {
    if !is_safe_source_name(name) {
        return Err(invalid("manifest.runtime.file is required"));
    }
    if let Some((ref manifest, _)) = &declared {
        validate_manifest(manifest)?;
    }
    let file_bytes = fs::read(dir.join(name))?;
    if let Some((ref manifest, _)) = &declared {
        let expected = manifest
            .pointer("/runtime/sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("manifest.runtime.sha256 is required"))?;
        if hash(&file_bytes) != expected {
            return Err(CompilerError::new(
                "SOURCE_HASH_MISMATCH",
                "glTF hash differs from manifest",
            ));
        }
    }
    let declared_ref = declared.as_ref().map(|(m, _)| m);
    let (mut g, binary, offsets, sidecars) = if is_glb(&file_bytes) {
        let (g, bin) = parse_glb(&file_bytes)?;
        let (binary, offsets, sidecars) = concat_gltf_buffers(dir, &g, Some(&bin), declared_ref)?;
        (g, binary, offsets, sidecars)
    } else {
        let g: Value = serde_json::from_slice(&file_bytes)?;
        let (binary, offsets, sidecars) = concat_gltf_buffers(dir, &g, None, declared_ref)?;
        (g, binary, offsets, sidecars)
    };
    flatten_buffer_views(&mut g, &offsets, binary.bytes().len())?;
    expand_gpu_instances(&mut g, binary.bytes())?;
    let bin_hash = hash(binary.bytes());
    let (manifest, manifest_bytes) = if let Some(pair) = declared {
        pair
    } else {
        let (mesh_nodes, triangles) = source_stats(&g)?;
        let manifest = runtime_manifest(name, &hash(&file_bytes), &sidecars, mesh_nodes, triangles);
        let manifest_bytes = serde_json::to_vec(&manifest)?;
        (manifest, manifest_bytes)
    };
    Ok(RuntimeSource {
        manifest,
        manifest_bytes,
        g,
        g_bytes: file_bytes,
        binary,
        bin_hash,
    })
}
/// Loads the intermediate scene the router prepared. A converted scene has moved
/// `o.source` onto its cache folder: it is then re-read through its manifest, like
/// a source that already carries one.
pub(super) fn load_runtime(o: &Options, prepared: &PreparedScene) -> Result<RuntimeSource> {
    match prepared {
        PreparedScene::InPlace(name) if o.source.is_file() => load_model_file(
            o.source
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new(".")),
            name,
            None,
        ),
        PreparedScene::InPlace(name) => load_model_file(&o.source, name, None),
        PreparedScene::Manifest | PreparedScene::Converted { .. } => {
            let manifest_bytes = fs::read(o.source.join("manifest.json"))?;
            let manifest: Value = serde_json::from_slice(&manifest_bytes)?;
            validate_manifest(&manifest)?;
            let gltf_file = manifest
                .get("runtime")
                .and_then(|r| r.get("file"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| invalid("manifest.runtime.file is required"))?;
            load_model_file(&o.source, &gltf_file, Some((manifest, manifest_bytes)))
        }
    }
}
