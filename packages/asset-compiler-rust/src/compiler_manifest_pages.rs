//! The manifest as a page tree (#762): `clusters.json` is a root of fixed size — the fields that
//! name the product, the slot of its head page and `FAN_OUT` slots of mesh pages, in the layout of
//! the cell index and read by its pager (`partition/pages.rs`). The head page holds every other field and
//! the previews' sidecar; a mesh page, slim primitives and their sidecar, cut under `PAGE_BYTES`
//! (#792). Files are named by content.
use super::*;
use crate::compiler_tables::partition::{pages::*, split::halving};
use crate::manifest_binary::{columns, Templates, MANIFEST_BINARY_VERSION};
use crate::texture_preview::TexturePreview;
use serde_json::Map;
use std::{cell::RefCell, ops::Range};

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

/// Where a manifest's per-page URLs point: the shared objects, by fingerprint.
pub(crate) const TEMPLATES: Templates = Templates {
    page: "../../objects/{sha}.bin",
    geometry: "../../objects/{sha}.bin",
    bundle: "../../objects/{sha}.bin",
};

/// The mesh pages of a compile, written before the tables whose region pages name them (#792).
pub(crate) struct MeshPages {
    /// The root's slots, the empty ones last.
    pub slots: Vec<String>,
    /// The slots of the region pages each mesh's primitives lie in, by mesh rank.
    pub by_mesh: MeshSlots,
    /// The fingerprints of every page and sidecar written, which the sweep keeps.
    kept: BTreeSet<String>,
}

/// Writes `primitives` in order as mesh pages in `directory`, cut through the pager: a region page
/// is one primitive, or primitives whose page fits `PAGE_BYTES`, each with its own sidecar.
pub(crate) fn write_mesh_pages(primitives: &[Value], directory: &Path) -> Result<MeshPages> {
    let kind = &MANIFEST_PAGES;
    let (whole, _) = columns(&Map::new(), primitives, &TEMPLATES, &[])?;
    let mut starts = vec![0];
    for slim in whole[kind.records]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
    {
        starts.push(starts[starts.len() - 1] + serde_json::to_vec(slim)?.len() + 1);
    }
    // The sidecar of each range laid out: only a written region page's reaches the disk.
    let sidecars = RefCell::new(BTreeMap::new());
    let leaf = |range: Range<usize>| -> Result<Value> {
        let key = (range.start, range.end);
        let (mut page, bytes) = columns(&Map::new(), &primitives[range], &TEMPLATES, &[])?;
        let sha256 = hash(&bytes);
        page["binary"]["url"] = json!(sidecar_file(&sha256));
        page["binary"]["sha256"] = json!(&sha256);
        sidecars.borrow_mut().insert(key, (sha256, bytes));
        Ok(page)
    };
    let pager = Pager::new(kind, starts, &[], directory, &leaf)?;
    let slots = pager.root(&halving(0..primitives.len()))?;
    let (mut by_mesh, mut kept) = (MeshSlots::new(), BTreeSet::new());
    for (range, slot) in pager.leaves() {
        let (sha256, bytes) = sidecars
            .borrow_mut()
            .remove(&(range.start, range.end))
            .expect("laid out");
        atomic(&directory.join(sidecar_file(&sha256)), &bytes)?;
        kept.extend([sha256, slot[..64].to_string()]);
        for mesh in primitives[range].iter().filter_map(|p| p["mesh"].as_u64()) {
            let pages = by_mesh.entry(mesh).or_insert_with(Vec::new);
            if pages.last() != Some(&slot) {
                pages.push(slot.clone());
            }
        }
    }
    Ok(MeshPages {
        slots,
        by_mesh,
        kept,
    })
}

/// Writes the manifest `result` as pages in `directory` — `extra` among its fields, the texture
/// previews in the head's sidecar, its primitives in `mesh`, already written — then its root, and
/// removes the pages an older root named.
pub(crate) fn write_manifest(
    result: &Value,
    extra: Value,
    previews: &[TexturePreview],
    mesh: &MeshPages,
    directory: &Path,
) -> Result<()> {
    let mut top = result.as_object().expect("a manifest").clone();
    top.remove(MANIFEST_PAGES.records);
    if let Value::Object(extra) = extra {
        top.extend(extra);
    }
    let mut root = Map::new();
    for field in FIXED {
        root.extend(top.remove_entry(field));
    }
    let (mut head, bytes) = columns(&top, &[], &TEMPLATES, previews)?;
    let sha256 = hash(&bytes);
    atomic(&directory.join(sidecar_file(&sha256)), &bytes)?;
    head["binary"]["url"] = json!(sidecar_file(&sha256));
    head["binary"]["sha256"] = json!(&sha256);
    head["version"] = json!(MANIFEST_PAGES.version);
    let slot = write_page(&MANIFEST_PAGES, directory, &head, &[])?;
    let mut kept = mesh.kept.clone();
    kept.extend([sha256, slot[..64].to_string()]);
    root.insert("head".into(), json!(slot));
    root.insert("pages".into(), json!(mesh.slots));
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
