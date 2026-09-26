use super::*;
use crate::texture_preview::coverage::{cut_bin, filtered_covered, scale_table};

/// Filtered samples of a square `level` (RGBA8) at or above `cutoff`, four a texel.
fn covered(level: &[u8], cutoff: u8) -> u64 {
    filtered_covered(level, ((level.len() / 4) as f64).sqrt() as usize, cutoff)
}

/// Levels of square `chain` whose filtered samples at or above `cutoff` stray from level 0's
/// share by more than 2.5 %, or by more than one texel's four where 2.5 % is less: a level cannot
/// cover a fraction of a texel.
pub(super) fn strays(chain: &[Vec<u8>], cutoff: u8) -> Vec<usize> {
    let share = covered(&chain[0], cutoff) as f64 / chain[0].len() as f64;
    (0..chain.len())
        .filter(|&k| {
            let target = share * chain[k].len() as f64;
            (covered(&chain[k], cutoff) as f64 - target).abs() > (0.025 * target).max(4.0)
        })
        .collect()
}

// #43: coverage is counted on the bilinearly filtered cut, not on the texels. On this noise the
// two disagree — a chain holding the texel counts strays at 8² —, and the compiler's filtered
// counts are the table every builder of the card stays within 2.5 % of (`leafCoverage.test.ts`).
#[test]
fn coverage_holds_on_the_filtered_cut() {
    let table: Value = serde_json::from_str(include_str!(
        "../../../../../tests/fixtures/formats/previews/coverage-filtered.json"
    ))
    .expect("table");
    let side = table["side"].as_u64().expect("side") as u32;
    let alpha: Vec<u8> = table["alpha"]
        .as_array()
        .expect("rows")
        .iter()
        .flat_map(|row| {
            row.as_str()
                .expect("row")
                .split_whitespace()
                .map(|a| a.parse().expect("byte"))
        })
        .collect();
    let cutoff = table["cutoff"].as_u64().expect("cutoff") as u8;
    let source = rgba_from(side, side, |x, y| [9, 9, 9, alpha[(y * side + x) as usize]]);
    let chain = reduce::chain(&source, AtlasKind::Coverage(cutoff));
    assert_eq!(strays(&chain, cutoff), [0usize; 0]);
    let counts: Vec<u64> = chain.iter().map(|level| covered(level, cutoff)).collect();
    let expected: Vec<u64> = serde_json::from_value(table["covered"].clone()).expect("covered");
    assert_eq!(counts, expected[..counts.len()]);
}

// #43: the bin search starts between a square's lowest and highest corners, and four equal
// corners take their byte as bin with no search. Both are exact: every square below, at every
// cutoff, lands in the bin a scan of all 255 `t` finds, on the rule's arithmetic written out.
#[test]
fn the_bin_search_between_the_corners_finds_the_scan_s_bin() {
    let scan = |a: [u32; 4], s: u32, c: u32| {
        let lift = |a: u32, t: u32| ((2 * a * (2 * c - 1) + 2 * t - 1) / (4 * t - 2)).min(255);
        let (x, y) = (3 - 2 * (s & 1), 3 - 2 * (s >> 1));
        (1..=255u32)
            .rev()
            .find(|&t| {
                let [a, b, d, e] = a.map(|a| lift(a, t));
                (y * (x * a + (4 - x) * b) + (4 - y) * (x * d + (4 - x) * e) + 8) >> 4 >= c
            })
            .unwrap_or(0) as usize
    };
    let mut seed = 0x2545_f491u32;
    let mut byte = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        [0, 255, seed & 255, seed >> 24][(seed >> 8 & 3) as usize]
    };
    for c in [1, 64, 128, 191, 255] {
        let bytes = scale_table(c);
        // Flat squares, one corner a byte apart either way, then noise heavy in 0 and 255.
        let near = (1..=255).flat_map(|a| [[a; 4], [a, a - 1, a - 1, a - 1], [a - 1, a, a, a]]);
        let squares = near.chain((0..4000).map(|_| [(); 4].map(|_| byte())));
        for square in squares.collect::<Vec<_>>() {
            for s in 0..4 {
                assert_eq!(
                    cut_bin(square, s, c, &bytes),
                    scan(square, s, c),
                    "{square:?} {s} {c}"
                );
            }
            if square.iter().all(|&a| a == square[0]) {
                assert_eq!(scan(square, 0, c), square[0] as usize, "{square:?} {c}");
            }
        }
    }
}
