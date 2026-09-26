//! Golden of progressive previews: the only coverage of the full path real glTF →
//! `compile()` → cache → binary sidecar for the `texturePreviews` section. The
//! in-vitro tests in `texture_preview/tests/` fix the math on images built in
//! memory; this one fixes the bytes an engine will actually read, PNG and JPEG
//! decoders included.
use super::*;

/// Sidecar columns, in the order `packages/sdk-core/src/manifest/binaryFormat.ts`
/// publishes under `COLUMN_NAMES`. The golden rereads them by rank, like an
/// outside reader, without borrowing the writer's private constants: a rank that
/// moves is a format change, not a detail.
const HEADER_WORDS: usize = 4;
const TEXTURE_PREVIEW_U32: usize = 21;
const TEXTURE_PREVIEW_SHA: usize = 22;
const TEXTURE_PREVIEW_PIXELS: usize = 23;
/// The tails block-compressed, the BC family then ASTC 4 × 4: no offset written,
/// one contiguous range per entry the family kept, whose length follows from its
/// dimensions; nothing for an entry whose layout word says lossless.
const TEXTURE_PREVIEW_BLOCKS: [(&str, usize); 2] = [("bc7", 24), ("astc", 25)];
/// Numbers per entry: texture, image, width, height, kind and provenance view,
/// first level, level count, pixel start and length, atlas, levels baked to
/// files, then the layout word of each family.
const PREVIEW_WORDS: usize = 14;
const PREVIEW_LAYOUTS: usize = 12;
/// `alphaCutoff` of the fixture's MASK material, as a byte: 0.25 × 255 rounded.
/// Counting texels that reach it at each level says at a glance whether mask
/// coverage was preserved, and whether the alpha of the two unmasked textures
/// stayed intact.
const MASK_CUTOFF_BYTE: u8 = 64;

// Behaviour 24: the golden textured fixture goes through the compiler and every
// byte of its previews is compared to expected.json — provenance, level geometry,
// pixels and coverage.
#[test]
fn texture_previews_match_their_golden_expected_json() {
    let fixture_dir = golden_dir("previews/atlas-couleur");
    let run = compile_golden(&fixture_dir, "atlas-couleur");
    assert_eq!(
        previews_digest(&run),
        golden_expected(&fixture_dir),
        "fixture atlas-couleur: texture previews diverge from expected.json"
    );
}

/// Digest the golden compares: the stage report, the slim-manifest counters, then
/// for each sidecar entry its provenance and each of its levels byte by byte.
pub(in crate::tests) fn previews_digest(run: &GoldenRun) -> Value {
    let bytes = &run.previews;
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().expect("word"));
    let column = |index: usize| {
        let at = (HEADER_WORDS + index * 2) * 4;
        (word(at) as usize, word(at + 4) as usize)
    };
    let (words_at, words_len) = column(TEXTURE_PREVIEW_U32);
    let (sha_at, _) = column(TEXTURE_PREVIEW_SHA);
    let (pixels_at, _) = column(TEXTURE_PREVIEW_PIXELS);
    let mut blocks_at = TEXTURE_PREVIEW_BLOCKS.map(|(_, index)| column(index).0);
    let previews: Vec<Value> = (0..words_len / (PREVIEW_WORDS * 4))
        .map(|entry| {
            let base = words_at + entry * PREVIEW_WORDS * 4;
            let sha = &bytes[sha_at + entry * 64..sha_at + entry * 64 + 64];
            let mut digest = entry_digest(
                bytes,
                base,
                pixels_at,
                std::str::from_utf8(sha).expect("sha"),
                word,
            );
            let kept = texture_preview::preview_block_bytes(word(base + 8), word(base + 12));
            digest["blocks"] = TEXTURE_PREVIEW_BLOCKS
                .iter()
                .zip(blocks_at.iter_mut())
                .enumerate()
                .map(|(family, ((format, _), at))| {
                    let layout = word(base + (PREVIEW_LAYOUTS + family) * 4);
                    let length = if layout == 0 { 0 } else { kept };
                    let tail = &bytes[*at..*at + length];
                    *at += length;
                    json!({"format": format, "layout": layout, "bytes": length, "sha256": hash(tail)})
                })
                .collect();
            digest
        })
        .collect();
    json!({
      "formatVersion": run.result["formatVersion"],
      "manifestBinaryVersion": run.slim["binary"]["version"],
      "textures": run.slim["textures"],
      "report": run.result["texturePreviews"],
      "binary": {
        "texturePreviews": run.slim["binary"]["texturePreviews"],
        "texturePreviewBytes": run.slim["binary"]["texturePreviewBytes"],
        "texturePreviewBc7Bytes": run.slim["binary"]["texturePreviewBc7Bytes"],
        "texturePreviewAstcBytes": run.slim["binary"]["texturePreviewAstcBytes"],
      },
      "previews": previews,
    })
}

/// One entry: the twelve numbers it declares, the digest of its source image, and
/// the sequence of its levels sliced at the dimensions `preview_level_size`
/// re-reduces — never at those announced.
fn entry_digest(
    bytes: &[u8],
    base: usize,
    pixels_at: usize,
    sha256: &str,
    word: impl Fn(usize) -> u32,
) -> Value {
    let (width, height) = (word(base + 8), word(base + 12));
    let first = word(base + 24);
    let mut at = pixels_at + word(base + 32) as usize;
    let mut levels = Vec::new();
    for level in first..first + word(base + 28) {
        let (w, h) = texture_preview::preview_level_size(width, height, level);
        let end = at + (w as usize) * (h as usize) * 4;
        levels.push(level_digest(level, w, h, &bytes[at..end]));
        at = end;
    }
    json!({
      "texture": word(base), "image": word(base + 4), "width": width, "height": height,
      "sourceKind": word(base + 16), "sourceView": word(base + 20),
      "firstLevel": first, "levelCount": word(base + 28),
      "pixelOffset": word(base + 32), "pixelBytes": word(base + 36),
      "atlas": word(base + 40), "bakedLevels": word(base + 44),
      "sourceSha256": sha256, "levels": levels,
    })
}

/// One level: its dimensions, the digest of all its bytes — a single one that
/// changes makes the golden blush — then five texels and coverage at the
/// threshold, so the diff says *where* the computation moved.
fn level_digest(level: u32, w: u32, h: u32, texels: &[u8]) -> Value {
    let texel = |x: u32, y: u32| {
        let at = ((y * w + x) * 4) as usize;
        json!(&texels[at..at + 4])
    };
    let covered = texels
        .iter()
        .skip(3)
        .step_by(4)
        .filter(|alpha| **alpha >= MASK_CUTOFF_BYTE)
        .count();
    json!({
      "level": level, "size": [w, h], "sha256": hash(texels), "coveredAtMaskCutoff": covered,
      "samples": [texel(0, 0), texel(w - 1, 0), texel(0, h - 1), texel(w - 1, h - 1),
                  texel(w / 2, h / 2)],
    })
}
