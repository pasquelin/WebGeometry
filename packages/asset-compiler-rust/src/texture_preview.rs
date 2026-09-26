//! Mip chain of each atlas texture, baked once for all.
//!
//! Engine wrote tail of chain — from level with no side exceeding `PREVIEW_BASE`
//! to 1x1 — from sidecar, then waited for full resolution and regenerated ALL
//! rest on GPU. Between 64 px and source no level existed: texture
//! needing 256 px had to load and decode 2048², residence could
//! not keep up with screen. Here, every level exists: tail in sidecar,
//! RGBA8; levels above are lossless PNGs in cache, one file per level,
//! addressed by source byte hash and chain (`textures/<sha>/<srgb|linear|srgb-coverage[-<C>]>-<k>.png`),
//! shared across scenes sharing image, never rewritten if present. Beside each
//! PNG, when a quality gate lets it, the same level block-compressed in the
//! families the cook asked for — the BC family for desktop cards, ASTC for
//! mobile ones — and the tail carried in those blocks too (`blocks.rs`): one
//! byte per texel in the pool instead of four, and no visible loss, since a
//! chain the read-back cannot reproduce within the bar stays lossless.
//!
//! Reduction rule matches GPU (`reduce.rs`): baking instead of
//! regenerating does not change image. Covers both engine atlases — base color
//! and emissive in one, metallic-roughness, normal, occlusion in other —, each by own curve.
//!
//! Failed decode — format outside image driver registry, corrupt PNG, missing
//! image — is named report entry and zero levels: compilation never fails
//! for texture, engine falls back to default white.
use super::*;
use std::sync::atomic::AtomicUsize;

pub(crate) mod bake;
mod bake_write;
pub(crate) mod blocks;
pub(crate) mod collect;
mod coverage;
mod curves;
mod entry;
mod gate;
mod levels;
mod reduce;
mod report;
pub(crate) mod source;
#[cfg(test)]
pub(crate) mod tests;
mod verdict;
pub use entry::{PreviewSource, TexturePreview};
pub use levels::*;

/// Section contract: moving level scale, order, reduction rule, color space,
/// a block codec or the gate's bar requires incrementing this version and
/// binary sidecar version carrying it. Version 3 is GPU rule and full chain,
/// both atlases included; version 4 adds the gated block-compressed levels and
/// tails. A new chain under a name of its own moves no existing file and needs
/// no increment: the `Coverage` chain (#42) is one, and so is each cutoff's
/// coverage-preserving chain (#44), `srgb-coverage-<C>`. Version 5 counts that
/// chain's coverage on the filtered cut (#43): its bytes move under the same
/// names, and level files are written only when missing.
pub const TEXTURE_PREVIEW_VERSION: u32 = 5;
pub use bake_write::{level_path, texture_version_dir, LEVEL_WRITE_FAILED, LOSSLESS, TEXTURE_DIR};
pub use blocks::{BlockFormat, Layout};
pub use reduce::AtlasKind;
/// Baked level template path, relative to `native/`; `bake_write::level_path`
/// populates. `{format}` is `png`, or a block format's name.
pub fn level_template() -> String {
    format!(
        "{}/{{sha}}/{{kind}}-{{level}}.{{format}}",
        bake_write::texture_version_dir()
    )
}
/// Largest side sidecar level can have. Choice bounds section: at most
/// 21,844 bytes per texture vs megabytes a 256/512 level would add.
pub const PREVIEW_BASE: u32 = 64;
/// Max levels entry carries: 64, 32, 16, 8, 4, 2, 1.
pub const PREVIEW_MAX_LEVELS: u32 = 7;
/// Decode memory allocation ceiling. Larger image is report entry, not failure.
const PREVIEW_MAX_ALLOC: u64 = 512 * 1024 * 1024;

/// Everything step reads. `view_map` translates input glTF views to those written in
/// `source.gltf`, so origin names index engine sees.
pub(super) struct PreviewInputs<'a> {
    pub o: &'a Options,
    pub g: &'a Value,
    pub bin: &'a [u8],
    /// Resolution root of intermediate scene images, named by `plugins::scene`:
    /// source folder, or extracted folder of container — never cache folder.
    pub image_root: &'a Path,
    pub meshes: &'a BTreeSet<usize>,
    pub view_map: &'a BTreeMap<usize, usize>,
    /// Textures whose alpha to measure on pass, designated by `cutout`: this step
    /// knows what it decodes, not what cutout is.
    pub to_measure: &'a BTreeSet<usize>,
}

/// Calculates chain for each atlas texture of retained meshes, single image decode
/// once regardless of citing textures. Returns entries sorted by texture then
/// atlas, candidate cutout alpha shape — measured in this decode,
/// never second —, and step report. Images processed in parallel on
/// caller pool, each within decode allocation limit.
pub(super) fn stage_texture_previews(
    inputs: &PreviewInputs<'_>,
    progress: &(impl Fn(Value) + Sync),
) -> Result<(
    Vec<TexturePreview>,
    BTreeMap<usize, crate::cutout::AlphaShape>,
    Value,
)> {
    let wanted = collect::atlas_textures(inputs.g, inputs.meshes)?;
    let (Some(textures), Some(images)) = (
        inputs.g.get("textures").and_then(Value::as_array),
        inputs.g.get("images").and_then(Value::as_array),
    ) else {
        let report = report::report(
            inputs.o,
            &wanted,
            &[],
            &[],
            &BTreeMap::new(),
            &BTreeMap::new(),
        );
        return Ok((Vec::new(), BTreeMap::new(), report));
    };
    // Per image: (texture, atlas) reading it. Texture without image is report
    // entry, not image to decode.
    let mut by_image: BTreeMap<usize, Vec<collect::AtlasTexture>> = BTreeMap::new();
    let mut skipped: BTreeMap<&'static str, usize> = BTreeMap::new();
    for entry in &wanted {
        match textures
            .get(entry.texture)
            .ok_or("texture-out-of-bounds")
            .and_then(|t| {
                t.get("source")
                    .and_then(Value::as_u64)
                    .ok_or("texture-without-image")
            }) {
            Ok(image) => by_image
                .entry(image as usize)
                .or_default()
                .push(entry.clone()),
            Err(reason) => *skipped.entry(reason).or_default() += 1,
        }
    }
    let done = AtomicUsize::new(0);
    let total = by_image.len();
    let results: Vec<_> = by_image
        .par_iter()
        .map(|(&image_index, readers)| {
            check(inputs.o)?;
            let outcome = bake::one_image(inputs, images, image_index, readers);
            let completed = done.fetch_add(1, Ordering::Relaxed) + 1;
            progress(json!({"phase":"textures","completed":completed,"total":total}));
            Ok(outcome)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut previews = Vec::new();
    let mut shapes = BTreeMap::new();
    let mut gates = Vec::new();
    let mut notes: BTreeMap<&'static str, usize> = BTreeMap::new();
    for outcome in results {
        match outcome {
            Ok(baked) => {
                shapes.extend(baked.shapes);
                for note in baked.notes {
                    *notes.entry(note).or_default() += 1;
                }
                previews.extend(baked.previews);
                gates.extend(baked.gates);
            }
            Err((reason, count)) => *skipped.entry(reason).or_default() += count,
        }
    }
    previews.sort_by_key(|p| (p.texture, p.kind.atlas()));
    gates.sort_by(|a, b| {
        (&a.sha256, a.kind, a.format.name()).cmp(&(&b.sha256, b.kind, b.format.name()))
    });
    let report = report::report(inputs.o, &wanted, &previews, &gates, &skipped, &notes);
    Ok((previews, shapes, report))
}
