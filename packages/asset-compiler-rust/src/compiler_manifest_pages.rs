//! The manifest as a page tree (#762): `clusters.json` is a root of fixed size — the fields that
//! name the product, the slot of its head page and `FAN_OUT` slots of mesh pages, in the layout of
//! the cell index and read by its pager (`partition/pages.rs`). The head page holds every other field and
//! the previews' sidecar; a mesh page, slim primitives and their sidecar. Files are named by content.
use super::*;
use crate::compiler_tables::partition::pages::*;
use crate::manifest_binary::{columns, Templates, MANIFEST_BINARY_VERSION};
use crate::texture_preview::TexturePreview;
use serde_json::Map;

/// The manifest's pages: a mesh page lists its slim primitives.
pub(crate) const MANIFEST_PAGES: Kind = Kind {
    prefix: "manifest-page-",
    version: MANIFEST_BINARY_VERSION,
    records: "primitives",
};
/// The fields the root keeps: what names the product, whatever the world.
#[rustfmt::skip]
const FIXED: [&str; 6] = ["status", "formatVersion", "schema", "scope", "key", "compilerVersion"];

/// The file of the sidecar whose fingerprint is `sha256`.
pub(crate) fn sidecar_file(sha256: &str) -> String {
    format!("{}{sha256}.bin", MANIFEST_PAGES.prefix)
}

/// Writes the manifest `result` as pages in `directory`, `extra` among its fields and the texture
/// previews in the head's sidecar, then its root, and removes the pages an older root named.
pub(crate) fn write_manifest(
    result: &Value,
    extra: Value,
    previews: &[TexturePreview],
    templates: &Templates,
    directory: &Path,
) -> Result<()> {
    let mut top = result.as_object().expect("a manifest").clone();
    let primitives = top.remove(MANIFEST_PAGES.records).unwrap_or_default();
    let primitives = primitives.as_array().map_or(&[][..], Vec::as_slice);
    if let Value::Object(extra) = extra {
        top.extend(extra);
    }
    let mut root = Map::new();
    for field in FIXED {
        root.extend(top.remove_entry(field));
    }
    // The page of `primitives` and `previews` under `top` and its sidecar, both `kept`; its slot.
    let mut kept = BTreeSet::new();
    let mut page = |top: &Map<String, Value>, primitives: &[Value], previews| -> Result<String> {
        let (mut page, bytes) = columns(top, primitives, templates, previews)?;
        let sha256 = hash(&bytes);
        atomic(&directory.join(sidecar_file(&sha256)), &bytes)?;
        page["binary"]["url"] = json!(sidecar_file(&sha256));
        page["binary"]["sha256"] = json!(&sha256);
        page["version"] = json!(MANIFEST_PAGES.version);
        let slot = write_page(&MANIFEST_PAGES, directory, &page, &[])?;
        kept.extend([sha256, slot[..64].to_string()]);
        Ok(slot)
    };
    root.insert("head".into(), json!(page(&top, &[], previews)?));
    // One mesh page lists every primitive (#792 cuts them under `PAGE_BYTES`).
    let mut pages = vec![page(&Map::new(), primitives, &[])?];
    pages.resize(FAN_OUT, "0".repeat(SLOT_WIDTH));
    root.insert("pages".into(), json!(pages));
    atomic(&directory.join(MANIFEST_FILE), &serde_json::to_vec(&root)?)?;
    // A refused folder is rebuilt under its key, which prune keeps whole: its old pages go here.
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.starts_with(MANIFEST_PAGES.prefix) && !kept.iter().any(|s| name.contains(s)) {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// A manifest read back through its pages: every field in one value — the root's, the head's and
/// the primitives of every mesh page in order — and the sidecars, the head's first.
pub(crate) struct Paged {
    pub manifest: Value,
    pub sidecars: Vec<Vec<u8>>,
}

/// The sidecar `binary` describes, read from `directory` and proven by its size and fingerprint.
fn read_sidecar(directory: &Path, binary: &Value) -> std::result::Result<Vec<u8>, String> {
    let sha256 = binary["sha256"].as_str().unwrap_or_default();
    let name = sidecar_file(sha256);
    let data = fs::read(directory.join(&name)).map_err(|e| format!("{name}: {e}"))?;
    if Some(data.len() as u64) != binary["bytes"].as_u64() || hash(&data) != sha256 {
        return Err(format!("{name} is not the sidecar its page names"));
    }
    Ok(data)
}

/// The manifest whose root is `root`, in `directory`, each page and sidecar proven by its size and
/// fingerprint.
pub(crate) fn read_manifest(directory: &Path, root: &Value) -> std::result::Result<Paged, String> {
    let kind = &MANIFEST_PAGES;
    let head = read_slot(kind, directory, &root["head"], "the root")?;
    let Some((_, Value::Object(mut manifest))) = head else {
        return Err("the root names no head page".into());
    };
    let mut pages = Vec::new();
    read_leaves(kind, directory, &root["pages"], "the root", &mut pages)?;
    let mut sidecars = vec![read_sidecar(directory, &manifest["binary"])?];
    let mut primitives = Vec::new();
    for mut page in pages {
        sidecars.push(read_sidecar(directory, &page["binary"])?);
        if let Value::Array(slim) = page[kind.records].take() {
            primitives.extend(slim);
        }
    }
    manifest.remove("version");
    for (field, value) in root.as_object().ok_or("the root is no object")? {
        if field != "head" && field != "pages" {
            manifest.insert(field.clone(), value.clone());
        }
    }
    manifest.insert(kind.records.into(), Value::Array(primitives));
    Ok(Paged {
        manifest: Value::Object(manifest),
        sidecars,
    })
}

/// The manifest of the key folder `directory`, read through its root `clusters.json`.
pub(crate) fn read_manifest_at(directory: &Path) -> std::result::Result<Paged, String> {
    let text =
        fs::read(directory.join(MANIFEST_FILE)).map_err(|e| format!("{MANIFEST_FILE}: {e}"))?;
    let root = serde_json::from_slice(&text).map_err(|e| format!("{MANIFEST_FILE}: {e}"))?;
    read_manifest(directory, &root)
}
