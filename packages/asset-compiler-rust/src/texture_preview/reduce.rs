use super::curves::{linear_to_srgb, srgb_table};
use super::*;

/// What the atlas layer does with the bytes, and therefore what reduction must do
/// with the same: the colour atlas is `rgba8unorm-srgb`, its first three channels
/// go through the sRGB curve; the data atlas is `rgba8unorm`, everything there is
/// linear. Alpha goes through no curve in either case — that is how WebGPU defines
/// these formats.
///
/// `Coverage` is a chain of the colour atlas too, the one of a texture EVERY
/// reader of which reads its alpha as coverage — the base colour of MASK or BLEND
/// materials —: the only chain whose colours `halve` weighs by alpha. It carries
/// the texture's cutoff byte, whose share of covered texels every level keeps
/// (`coverage.rs`); 0 when a reader blends, and the chain keeps the median alone.
/// Each cutoff has its own word and name, so its
/// files never mix with the plain chain of the same image, nor with another
/// cutoff's, read in another scene. Entries sort by the atlas that samples the
/// chain (`atlas`), so one texture carries a plain or a coverage colour entry, never both.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum AtlasKind {
    Color,
    Data,
    Coverage(u8),
}
impl AtlasKind {
    /// The sidecar's atlas word: 0, 1 or 2 in the low byte, a coverage chain's
    /// cutoff in the next one.
    pub fn word(self) -> u32 {
        match self {
            Self::Color => 0,
            Self::Data => 1,
            Self::Coverage(cutoff) => 2 | u32::from(cutoff) << 8,
        }
    }
    pub fn name(self) -> String {
        match self {
            Self::Color => "srgb".into(),
            Self::Data => "linear".into(),
            Self::Coverage(0) => "srgb-coverage".into(),
            Self::Coverage(cutoff) => format!("srgb-coverage-{cutoff}"),
        }
    }
    /// The atlas the chain is sampled in: a `Coverage` chain is the colour atlas's.
    pub fn atlas(self) -> Self {
        match self {
            Self::Coverage(_) => Self::Color,
            kind => kind,
        }
    }
    /// The atlas a sidecar word names; `None` for a word this version never wrote.
    pub fn from_word(word: u32) -> Option<Self> {
        let cutoff = u8::try_from(word >> 8).ok()?;
        match (word & 0xff, cutoff) {
            (0, 0) => Some(Self::Color),
            (1, 0) => Some(Self::Data),
            (2, cutoff) => Some(Self::Coverage(cutoff)),
            _ => None,
        }
    }
}

/// The ENTIRE mip chain of a source, level 0 included: `levels[k]` is level `k` in
/// RGBA8, at `preview_level_size` dimensions.
///
/// The rule is the one the engine applied on the GPU by regenerating the chain
/// after full resolution (`packages/sdk-browser/src/texture/mips.ts`), reproduced here
/// so baking levels instead of regenerating them does not change the image: each
/// level is computed from the PREVIOUS level already quantised to bytes, never
/// from a kept float; colours are the mean of the four texels, decoded then
/// re-encoded by the atlas curve, weighted by alpha in a `Coverage` chain
/// (`halve`); alpha is the MEDIAN of the four, the mean of the two middle
/// values, then scaled in a `Coverage` chain with a cutoff so that the share of
/// covered texels stays level 0's (`coverage.rs`); an
/// odd side repeats its last texel, like `min(p + 1, hi)` in the shader. No curve
/// declared by the file: the atlas does not know it, and the pyramid follows
/// display, not the file.
pub(super) fn chain(source: &image::RgbaImage, kind: AtlasKind) -> Vec<Vec<u8>> {
    let (width, height) = (source.width(), source.height());
    let last = preview_last_level(width, height);
    let mut levels = Vec::with_capacity(last as usize + 1);
    levels.push(source.as_raw().clone());
    let covered = super::coverage::Covered::of(source.as_raw(), width as usize, kind);
    let mut size = (width, height);
    for level in 1..=last {
        let next = preview_level_size(width, height, level);
        let previous = levels.last().expect("previous level");
        let mut halved = halve(previous, size, next, kind);
        if let Some(covered) = &covered {
            covered.preserve(&mut halved, next.0 as usize);
        }
        levels.push(halved);
        size = next;
    }
    levels
}

/// Tail the sidecar carries: levels from `preview_first_level` on, end to end.
pub(super) fn tail(levels: &[Vec<u8>], first: u32) -> Vec<u8> {
    levels[first as usize..].concat()
}

/// Table that brings a byte of the previous level back to the value the GPU
/// averages: the sRGB curve for colours of a colour atlas, division by 255 everywhere else.
fn decode_table(kind: AtlasKind) -> &'static [f32; 256] {
    match kind {
        AtlasKind::Color | AtlasKind::Coverage(_) => srgb_table(),
        AtlasKind::Data => super::curves::linear_table(),
    }
}

fn encode(value: f32, kind: AtlasKind) -> u8 {
    match kind {
        AtlasKind::Color | AtlasKind::Coverage(_) => linear_to_srgb(value),
        AtlasKind::Data => (value.clamp(0.0, 1.0) * 255.0).round() as u8,
    }
}

/// Next level from the previous bytes. `(u + v) / 2` is the median of four
/// values: `u` the second and `v` the third once sorted, six comparisons without a sort.
///
/// Colours are the plain mean of the four, except in a `Coverage` chain when their
/// alphas differ: there a transparent texel is no colour — its RGB, often black,
/// used to darken the borders of alpha-masked foliage at the coarse levels (#42)
/// —, so the four linear colours are premultiplied, averaged and divided by the
/// summed alpha, the atlas storing straight alpha. Four equal alphas keep the plain
/// mean byte for byte, which weighting could not change. Every other chain always
/// keeps it: where no reader takes alpha for coverage — an opaque base colour, an
/// emissive, a packed channel, a height beside a normal — the RGB under alpha 0 is
/// drawn, and weighting would change it.
fn halve(previous: &[u8], size: (u32, u32), next: (u32, u32), kind: AtlasKind) -> Vec<u8> {
    let table = decode_table(kind);
    let (width, height) = (size.0 as usize, size.1 as usize);
    let (columns, rows) = (next.0 as usize, next.1 as usize);
    let mut out = Vec::with_capacity(columns * rows * 4);
    for row in 0..rows {
        let y0 = (row * 2).min(height - 1);
        let y1 = (row * 2 + 1).min(height - 1);
        for column in 0..columns {
            let x0 = (column * 2).min(width - 1);
            let x1 = (column * 2 + 1).min(width - 1);
            let at = |x: usize, y: usize| (y * width + x) * 4;
            let texels = [at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1)];
            let a: [f32; 4] = std::array::from_fn(|i| f32::from(previous[texels[i] + 3]) / 255.0);
            let coverage = (matches!(kind, AtlasKind::Coverage(_)) && a.iter().any(|&w| w != a[0]))
                .then(|| a.iter().sum::<f32>());
            for channel in 0..3 {
                let values = texels.map(|t| table[previous[t + channel] as usize]);
                let mean = match coverage {
                    Some(sum) => values.iter().zip(a).map(|(v, w)| v * w).sum::<f32>() / sum,
                    None => values.iter().sum::<f32>() * 0.25,
                };
                out.push(encode(mean, kind));
            }
            let u = a[0].max(a[1]).min(a[2].max(a[3]));
            let v = a[0].min(a[1]).max(a[2].min(a[3]));
            out.push(((u + v) * 0.5 * 255.0).round() as u8);
        }
    }
    out
}
