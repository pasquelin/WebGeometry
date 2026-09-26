use super::coverage_filtered::strays;
use super::*;
use crate::texture_preview::collect::atlas_textures;
use crate::texture_preview::coverage::{cutoff_byte, Covered};

/// Foliage: a smooth random field cut by a soft edge, four octaves of value noise from 32 texels
/// down to 4, the alpha ramp two texels wide — what a leaf atlas's mask looks like.
fn foliage(side: u32) -> image::RgbaImage {
    let lattice = |x: u32, y: u32, seed: u32| {
        let mut h = x.wrapping_mul(374_761_393) ^ y.wrapping_mul(668_265_263) ^ seed;
        h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
        f32::from((h >> 16) as u16) / 65_535.0
    };
    let octave = |x: u32, y: u32, period: u32, seed: u32| {
        let (cx, cy) = (x / period, y / period);
        let smooth = |t: f32| t * t * (3.0 - 2.0 * t);
        let fx = smooth((x % period) as f32 / period as f32);
        let fy = smooth((y % period) as f32 / period as f32);
        let top = lattice(cx, cy, seed) * (1.0 - fx) + lattice(cx + 1, cy, seed) * fx;
        let bottom = lattice(cx, cy + 1, seed) * (1.0 - fx) + lattice(cx + 1, cy + 1, seed) * fx;
        top * (1.0 - fy) + bottom * fy
    };
    rgba_from(side, side, |x, y| {
        let n = [(32, 0.5), (16, 0.25), (8, 0.15), (4, 0.1)]
            .iter()
            .enumerate()
            .map(|(seed, &(period, weight))| weight * octave(x, y, period, seed as u32))
            .sum::<f32>();
        let alpha = ((n - 0.55) * 8.0 + 0.5).clamp(0.0, 1.0);
        [60, 140, 40, (alpha * 255.0).round() as u8]
    })
}

// #44: a masked chain keeps level 0's coverage at every level, whatever the cutoff; the median
// alone — develop's rule, which a blended-only chain keeps — thins the foliage out from 64 × 64.
#[test]
fn coverage_holds_at_every_level_of_a_masked_chain() {
    let source = foliage(512);
    for cutoff in [64, 128, 191] {
        let chain = reduce::chain(&source, AtlasKind::Coverage(cutoff));
        assert_eq!(strays(&chain, cutoff), [0usize; 0], "cutoff {cutoff}");
    }
    let median = reduce::chain(&source, AtlasKind::Coverage(0));
    assert_eq!(strays(&median, 128), [3, 4, 5, 6, 7, 8]);
}

// #44, steps 3 and 4: `a × (C − 0.5) / (t − 0.5)` rounded half up, in integers, on a table the
// card's test reads too (`texture/coverageRule.test.ts`, #748) — each case's alphas its histogram.
// Its first case: level 0 covers half at 128, the level two of four from `t` = 11 to 90, and 90
// is nearest the cutoff.
#[test]
fn the_scale_lands_on_the_cutoff_in_integers() {
    let table: Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/formats/previews/coverage-alpha.json"
    ))
    .expect("table");
    let bytes = |alphas: &str| -> Vec<u8> {
        let alphas = alphas.split_whitespace().map(|a| a.parse().expect("byte"));
        alphas.flat_map(|a: u8| [9, 9, 9, a]).collect()
    };
    let histogram = |level: &[u8]| {
        let mut bins = [0u64; 256];
        level
            .as_chunks::<4>()
            .0
            .iter()
            .for_each(|texel| bins[usize::from(texel[3])] += 1);
        bins
    };
    for case in table["cases"].as_array().expect("cases") {
        let parts: Vec<&str> = case.as_str().expect("case").split('|').collect();
        let [cutoff, level0, level, t, scaled] = parts[..] else {
            panic!("{case}")
        };
        let level0 = bytes(level0);
        let covered = Covered::counted(
            bytes(cutoff)[3],
            &histogram(&level0),
            level0.len() as u64 / 4,
        );
        let mut level = bytes(level);
        let picked = covered.pick(&histogram(&level), level.len() as u64 / 4);
        assert_eq!(picked, bytes(t)[3], "{case}");
        covered.scale(&mut level, picked);
        assert_eq!(level, bytes(scaled), "{case}");
    }
    assert!(
        Covered::of(&bytes("200 200 0 0"), 2, AtlasKind::Coverage(0)).is_none(),
        "blended: median alone"
    );
}

/// A material reading texture `texture` as its base colour, blended or cut at `cutoff`.
fn material(mode: &str, cutoff: f64, texture: usize) -> Value {
    json!({"pbrMetallicRoughness": {"baseColorTexture": {"index": texture}},
        "alphaMode": mode, "alphaCutoff": cutoff})
}

// #44: a texture is cut at the lowest cutoff of its masked readers, as the smallest byte the
// engine keeps (`alpha >= alphaTest`), and not at all — median alone — once one of them blends:
// the scale would move the mean alpha a blended surface draws.
#[test]
fn a_texture_is_cut_at_its_lowest_cutoff_unless_a_reader_blends() {
    assert_eq!(
        [0.5, 0.25, 1.0 / 255.0, 1.0].map(|c| cutoff_byte(c, 1.0)),
        [128, 64, 1, 255]
    );
    // The engine's product, never the cutoff over the factor: 0.66 / 0.9 × 255 is 187 on the dot,
    // which WebGL2 keeps and the quotient rounds to 188.
    assert_eq!(cutoff_byte(0.66, 0.9), 187);
    let kind_of = |materials: Vec<Value>| {
        let primitives: Vec<Value> = (0..materials.len())
            .map(|m| json!({"attributes": {}, "material": m}))
            .collect();
        let g = json!({"materials": materials, "meshes": [{"primitives": primitives}]});
        atlas_textures(&g, &BTreeSet::from([0])).expect("collect")[0].kind
    };
    let masked = vec![material("MASK", 0.5, 0), material("MASK", 0.25, 0)];
    assert_eq!(kind_of(masked.clone()), AtlasKind::Coverage(64));
    let mut with_blend = masked.clone();
    with_blend.push(material("BLEND", 0.9, 0));
    assert_eq!(kind_of(with_blend), AtlasKind::Coverage(0));
    // glTF 2.0 cuts the sampled alpha times the factor's: at 0.25 under a factor of 0.5, the
    // texture's own cutoff is 0.5.
    let fade = |mut materials: Vec<Value>, factor: f64| {
        let last = materials.len() - 1;
        materials[last]["pbrMetallicRoughness"]["baseColorFactor"] = json!([1, 1, 1, factor]);
        kind_of(materials)
    };
    assert_eq!(fade(masked.clone(), 0.5), AtlasKind::Coverage(128));
    // A factor of 0, or one at or under the cutoff, keeps at most the opaque texels: that reader
    // takes 255, and a texture another reader cuts keeps that reader's cutoff.
    for factor in [0.0, 0.25, 0.1] {
        let both = fade(masked.clone(), factor);
        assert_eq!(both, AtlasKind::Coverage(128), "{factor}");
        let alone = vec![masked[1].clone()];
        assert_eq!(fade(alone, factor), AtlasKind::Coverage(255), "{factor}");
    }
}

// #44: each cutoff names its own files and sidecar word, so two scenes cutting one image at two
// cutoffs never serve each other's levels, and a blended-only chain keeps develop's name.
#[test]
fn each_cutoff_names_its_own_chain() {
    let dir = temp_dir("bake-cutoffs");
    foliage(256).save(dir.join("map.png")).expect("save");
    let kinds = [("MASK", 0.5), ("MASK", 0.25), ("BLEND", 0.5)]
        .map(|(mode, cutoff)| stage_scene(&dir, &gate::scene(material(mode, cutoff, 0))).0[0].kind);
    assert_eq!(kinds, [128, 64, 0].map(AtlasKind::Coverage));
    let names = kinds.map(|kind| (kind.name(), kind.word()));
    let expected = [
        ("srgb-coverage-128", (128 << 8) | 2),
        ("srgb-coverage-64", (64 << 8) | 2),
        ("srgb-coverage", 2),
    ];
    assert_eq!(names, expected.map(|(name, word)| (name.into(), word)));
    for kind in kinds {
        assert_eq!(AtlasKind::from_word(kind.word()), Some(kind));
    }
    assert_eq!(AtlasKind::from_word(128 << 8), None, "only coverage is cut");
}

// #44: two textures of one image, one blended and one masked, bake one chain each: the blended
// one keeps the median alone, byte for byte, and only the masked one is scaled.
#[test]
fn a_blended_texture_keeps_the_median_beside_a_masked_one_of_its_image() {
    let dir = temp_dir("bake-shared-image");
    let source = foliage(256);
    source.save(dir.join("map.png")).expect("save");
    let primitives = [0, 1].map(|m| json!({"attributes": {}, "material": m}));
    let g = json!({
        "materials": [material("BLEND", 0.5, 0), material("MASK", 0.5, 1)],
        "meshes": [{"primitives": primitives}],
        "textures": [{"source": 0}, {"source": 0}],
        "images": [{"uri": "map.png"}],
    });
    let (previews, _) = stage_scene(&dir, &g);
    let kinds: Vec<_> = previews.iter().map(|p| p.kind).collect();
    assert_eq!(kinds, [AtlasKind::Coverage(0), AtlasKind::Coverage(128)]);
    let first = previews[0].first_level as usize;
    let tail = |kind| reduce::tail(&reduce::chain(&source, kind), first as u32);
    assert_eq!(previews[0].pixels, tail(AtlasKind::Coverage(0)));
    assert_eq!(previews[1].pixels, tail(AtlasKind::Coverage(128)));
    assert_ne!(previews[0].pixels, previews[1].pixels, "scaled");
}
