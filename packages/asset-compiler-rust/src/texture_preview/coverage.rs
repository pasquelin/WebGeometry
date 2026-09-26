//! Coverage-preserving alpha: the rule every builder of a coverage chain applies
//! after the median of four — this compiler, and the card's WebGPU and WebGL2
//! chains, which mirror it step for step (`texture/coverageRule.ts`, #748, #769).
//!
//! A masked material keeps a texel when its alpha times the material's
//! `baseColorFactor` alpha reaches the cutoff (glTF 2.0), and the median of four
//! does not keep the share of texels that do: on foliage the coarse levels thin
//! out (sponza's masked maps lose up to 57 % of their coverage at level 8, #44).
//! A texture's cutoff byte `C` is the lowest of its readers' effective cutoffs
//! (`material_cut`), 0 when one of them blends: a blended surface draws the
//! alpha itself, whose mean the scale would move. So, at every level `k ≥ 1` of
//! a coverage chain whose cutoff byte `C` is not 0:
//!
//! 1. the level is reduced as any other — colours, then the median alpha;
//! 2. coverage is counted on the bilinearly filtered cut, as the sampler draws it
//!    (Castaño's practice, #43), not on the texels: four samples a texel, at the
//!    quarter points of the square between its centre and those of its right,
//!    lower and diagonal neighbours (an edge texel its own neighbour), each the
//!    byte `(9a + 3b + 3c + d) / 16` of its corners rounded half up (`filtered`),
//!    as the cut keeps a filtered alpha at `C − 0.5`, where the scale puts `t − 0.5`.
//!    `n0` counts level 0's samples `≥ C`, `N0` and `Nk` are the texel counts of
//!    levels 0 and `k` (four samples a texel on both sides of the product), and
//!    `above(t)` counts level `k`'s samples that the scale at `t` (step 4) lifts
//!    to `≥ C`: each sample is filed in a 256-bin histogram under the highest
//!    such `t`, 0 when none (`cut_bin`, a binary search between the square's lowest
//!    and highest corners), so `above(t)` is exactly what the scaled level covers;
//! 3. `t` is the byte of `1..=255` that minimises `|above(t) × N0 − n0 × Nk|` —
//!    level 0's share, never the previous level's, so no error carries over —, a
//!    tie going to the `t` nearest `C`, then to the lower one;
//! 4. every alpha `a` of level `k` becomes `a × s` rounded half up, with
//!    `s = (C − 0.5) / (t − 0.5)`, computed in integers so that every builder
//!    lands on the same byte: `min(255, (2a(2C − 1) + 2t − 1) / (4t − 2))`, the
//!    division truncating. `t = C` leaves the level as it is.
//!
//! Level `k + 1` is reduced from these bytes. Colours are not touched. A chain
//! whose cutoff is 0 keeps the median alone.

use super::reduce::AtlasKind;

/// The smallest byte `b` a material keeps at `cutoff` under a `baseColorFactor`
/// alpha `factor`: `b / 255 × factor >= cutoff` in `f32`, the product glTF 2.0
/// cuts and both backends compute (`maskKeep`, #748; `baseFactor`, #769) —
/// dividing the cutoff by the factor instead would land a byte off on exact ties.
/// The quality gate cuts at the same product (`keeps`, `blocks/quality.rs`). 255
/// when no byte reaches it — a factor of 0 or below, or a cutoff above the factor,
/// keeps no texel —, which the lowest cutoff over a texture's readers ignores
/// beside any other one.
pub(super) fn cutoff_byte(cutoff: f32, factor: f32) -> u8 {
    (1..=255u8)
        .find(|&byte| keeps(byte, (cutoff, factor)))
        .unwrap_or(255)
}

/// A masked material's cut: its `alphaCutoff`, then its `baseColorFactor` alpha.
pub(crate) type Cut = (f32, f32);

/// Whether a masked material keeps a texel of alpha `alpha` under its `cut`:
/// `alpha / 255 × factor >= cutoff` in `f32`.
pub(super) fn keeps(alpha: u8, (cutoff, factor): Cut) -> bool {
    f32::from(alpha) / 255.0 * factor >= cutoff
}

/// A masked material's cut at `cutoff`, under its `baseColorFactor` alpha (1
/// when absent), clamped to [0, 1] as the engine's (`surfaceOpacity`).
pub(super) fn material_cut(material: &serde_json::Value, cutoff: f32) -> Cut {
    let factor = material
        .pointer("/pbrMetallicRoughness/baseColorFactor/3")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(1.0) as f32;
    (cutoff, factor.clamp(0.0, 1.0))
}

/// Bilinear sample `s` (0 to 3, row by row) of the square of corner alphas `[a, b,
/// c, d]`, rounded half up: 9, 3, 3, 1 sixteenths from the nearest (`filtered`, `coverageRule.ts`).
fn filtered([a, b, c, d]: [u32; 4], s: u32) -> u32 {
    let (x, y) = (3 - 2 * (s & 1), 3 - 2 * (s >> 1));
    (y * (x * a + (4 - x) * b) + (4 - y) * (x * c + (4 - x) * d) + 8) >> 4
}

/// Step 4: alpha `a` scaled to cutoff `c` at `t`.
fn scaled(a: u32, c: u32, t: u32) -> u32 {
    ((2 * a * (2 * c - 1) + 2 * t - 1) / (4 * t - 2)).min(255)
}

/// Step 2's bin of sample `s` of square `a`: the highest `t` whose scale, `bytes[t]`,
/// lifts it to `c` or more (`cutBin`, `coverageRule.ts`): a corner reaches `c` exactly while
/// `t` is at most its byte, and a sample lies between its corners, so the bin does too.
pub(super) fn cut_bin(a: [u32; 4], s: u32, c: u32, bytes: &[[u8; 256]; 256]) -> usize {
    let mut low = a.into_iter().min().unwrap_or(0) as usize;
    let mut high = a.into_iter().max().unwrap_or(0) as usize + 1;
    while high - low > 1 {
        let t = (low + high) >> 1;
        let lifted = filtered(a.map(|a| u32::from(bytes[t][a as usize])), s) >= c;
        *if lifted { &mut low } else { &mut high } = t;
    }
    low
}

/// Step 4's byte of every alpha at every `t` of `1..=255` for cutoff `c`; row 0 unused.
pub(super) fn scale_table(c: u32) -> Box<[[u8; 256]; 256]> {
    let mut bytes = Box::new([[0u8; 256]; 256]);
    for (t, row) in bytes.iter_mut().enumerate().skip(1) {
        *row = std::array::from_fn(|a| scaled(a as u32, c, t as u32) as u8);
    }
    bytes
}

/// The corner alphas of every texel's square in a level (RGBA8, `width` texels
/// a row), an edge texel its own neighbour.
fn squares(level: &[u8], width: usize) -> impl Iterator<Item = [u32; 4]> + '_ {
    let height = level.len() / 4 / width;
    let a = move |x: usize, y: usize| u32::from(level[(y * width + x) * 4 + 3]);
    (0..width * height).map(move |i| {
        let (x, y) = (i % width, i / width);
        let (right, below) = ((x + 1).min(width - 1), (y + 1).min(height - 1));
        [a(x, y), a(right, y), a(x, below), a(right, below)]
    })
}

/// Filtered samples of a level (RGBA8, `width` texels a row) at or above `c`.
pub(super) fn filtered_covered(level: &[u8], width: usize, c: u8) -> u64 {
    let c = u32::from(c);
    let passing = |a: [u32; 4]| (0..4).filter(|&s| filtered(a, s) >= c).count() as u64;
    squares(level, width).map(passing).sum()
}

/// What level 0 covers at the chain's cutoff: the share every level keeps.
pub(super) struct Covered {
    cutoff: u8,
    covered: u64,
    texels: u64,
}

impl Covered {
    /// Level 0's count at the cutoff of a `Coverage` chain that has one, `width`
    /// texels a row; `None` for every other chain, which keeps the median alone.
    pub(super) fn of(level0: &[u8], width: usize, kind: AtlasKind) -> Option<Self> {
        let AtlasKind::Coverage(cutoff @ 1..) = kind else {
            return None;
        };
        let covered = filtered_covered(level0, width, cutoff);
        Some(Self {
            cutoff,
            covered,
            texels: (level0.len() / 4) as u64,
        })
    }

    /// Level 0 at `cutoff` from its `histogram` of bins over `texels` texels.
    #[cfg(test)]
    pub(super) fn counted(cutoff: u8, histogram: &[u64; 256], texels: u64) -> Self {
        let covered = histogram[usize::from(cutoff)..].iter().sum();
        Self {
            cutoff,
            covered,
            texels,
        }
    }

    /// Scales the median alpha of `level` (RGBA8, `width` texels a row) so that
    /// its filtered share at or above the cutoff is level 0's, steps 2 to 4.
    pub(super) fn preserve(&self, level: &mut [u8], width: usize) {
        let c = u32::from(self.cutoff);
        let bytes = scale_table(c);
        let mut histogram = [0u64; 256];
        // Four equal corners — most of a foliage mask — are their bin, searched in no step.
        for square in squares(level, width) {
            (0..4).for_each(|s| histogram[cut_bin(square, s, c, &bytes)] += 1);
        }
        let t = self.pick(&histogram, (level.len() / 4) as u64);
        self.scale(level, t);
    }

    /// Step 4 at `t`: every alpha of `level` (RGBA8) scaled; `t = C` leaves it.
    pub(super) fn scale(&self, level: &mut [u8], t: u8) {
        let (c, t) = (u32::from(self.cutoff), u32::from(t));
        if t == c {
            return;
        }
        let bytes: [u8; 256] = std::array::from_fn(|a| scaled(a as u32, c, t) as u8);
        for texel in level.as_chunks_mut::<4>().0 {
            texel[3] = bytes[usize::from(texel[3])];
        }
    }

    /// Step 3: the byte whose count at or above it best matches level 0's share
    /// over a level of `texels` texels, ties to the one nearest the cutoff, then
    /// to the lower one.
    pub(super) fn pick(&self, histogram: &[u64; 256], texels: u64) -> u8 {
        let target = self.covered * texels;
        let mut above = 0u64;
        let mut best = (u64::MAX, u8::MAX, self.cutoff);
        for t in (1..=255u8).rev() {
            above += histogram[usize::from(t)];
            let error = (above * self.texels).abs_diff(target);
            best = best.min((error, t.abs_diff(self.cutoff), t));
        }
        best.2
    }
}
