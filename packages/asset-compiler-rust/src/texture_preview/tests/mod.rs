use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

mod atlas_rule;
mod bake_files;
mod box_reduce;
mod cancellation;
mod collect_textures;
mod coverage_alpha;
mod coverage_filtered;
mod decode_failure;
mod gate;
mod gate_verdict;
mod image_source;
mod levels;
mod median_alpha;
mod weighted_colour;

/// A fresh directory under the OS temp dir, unique per call so parallel tests never collide.
pub(super) fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "trillion3d-texture-preview-{tag}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}
/// Minimal `Options` a stage needs; only `cancelled`, `source` and `cache` ever matter to these tests.
pub(crate) fn options(source: &Path) -> Options {
    Options {
        source: source.to_path_buf(),
        cache: source.join("cache"),
        resource_base: "/assets/".into(),
        scope: "full".into(),
        triangle_budget: 1,
        threads: 1,
        ram_budget_mb: 64,
        simplification: "none".into(),
        texture_formats: vec![crate::texture_preview::BlockFormat::Bc7],
        cancelled: Arc::new(AtomicBool::new(false)),
    }
}
pub(super) fn rgba_from(
    width: u32,
    height: u32,
    pixel: impl Fn(u32, u32) -> [u8; 4],
) -> image::RgbaImage {
    image::RgbaImage::from_fn(width, height, |x, y| image::Rgba(pixel(x, y)))
}
/// Sidecar tail of a source, as `bake` produces: full chain reduced to
/// its levels starting from first carried.
pub(super) fn tail_of(source: &image::RgbaImage, kind: AtlasKind) -> (u32, Vec<u8>) {
    let first = preview_first_level(source.width(), source.height());
    (first, reduce::tail(&reduce::chain(source, kind), first))
}
/// Dimensions of level at `index` in tail, rank 0 coarsest carried.
pub(super) fn level_size(width: u32, height: u32, index: usize) -> (u32, u32) {
    preview_level_size(
        width,
        height,
        preview_first_level(width, height) + index as u32,
    )
}
/// A level's RGBA8 pixel bytes, sliced out of the tail's variable-length bytes.
pub(super) fn level_bytes(width: u32, height: u32, pixels: &[u8], index: usize) -> &[u8] {
    let mut start = 0usize;
    for step in 0..index {
        let (w, h) = level_size(width, height, step);
        start += (w * h * 4) as usize;
    }
    let (w, h) = level_size(width, height, index);
    &pixels[start..start + (w * h * 4) as usize]
}
/// Progress ignored by these tests.
pub(super) fn silent(_: Value) {}
/// Step run on source folder and scene, mesh 0 retained, nothing to measure,
/// the BC family cooked: shared by end-to-end tests. Returns entries and report.
pub(super) fn stage_scene(dir: &Path, g: &Value) -> (Vec<TexturePreview>, Value) {
    stage_scene_in(dir, g, vec![BlockFormat::Bc7])
}
/// The same, cooking `texture_formats`.
pub(super) fn stage_scene_in(
    dir: &Path,
    g: &Value,
    texture_formats: Vec<BlockFormat>,
) -> (Vec<TexturePreview>, Value) {
    let o = Options {
        texture_formats,
        ..options(dir)
    };
    let (meshes, view_map) = (BTreeSet::from([0usize]), BTreeMap::new());
    let (previews, _, report) = stage_texture_previews(
        &PreviewInputs {
            o: &o,
            g,
            bin: &[],
            image_root: dir,
            meshes: &meshes,
            view_map: &view_map,
            to_measure: &BTreeSet::new(),
        },
        &silent,
    )
    .expect("an unreadable texture never fails the compilation");
    (previews, report)
}
