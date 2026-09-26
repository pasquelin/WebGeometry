//! Decoder of a `WGP3` geometry page — quantized cluster geometry —, exact mirror of
//! `packages/sdk-browser/src/page/decode/geometryPage.ts` and of the WGSL routines of
//! `packages/sdk-browser/src/cluster/decodeWgsl.ts`.
//!
//! The same code serves two hosts: the native compiler, which encodes with the format's own
//! definitions (`bits.rs`) and proves that what it writes rereads identically, and the
//! `wasm32-unknown-unknown` module loaded by the browser. Refusals carry the same causes, in the
//! same order, as the JavaScript decoder: a byte that passes here passes there, a byte that falls
//! here falls there.
//!
//! This WebAssembly module is the SDK's, and there is only one: one compilation (`pnpm run
//! build:wasm`), one shipped resource, one instantiation and one linear memory on the browser side.
//! Beside the page decoder it therefore carries the math-foundation batch kernels (`math.rs`, ABI
//! in `wasm_math.rs`), the CPU cut's node walk (`cut.rs`, ABI in `wasm_cut.rs`), the normal cone
//! of the pages the world cuts at run time (`normal_cone.rs`, ABI in `wasm_cone.rs`) and the buffer
//! they share with JavaScript.

mod attributes;
pub mod bits;
pub mod cut;
pub mod cut_error;
pub mod math;
pub mod math_hierarchy;
pub mod normal_cone;
pub mod vec3;
#[cfg(target_arch = "wasm32")]
mod wasm;
#[cfg(target_arch = "wasm32")]
mod wasm_cone;
#[cfg(target_arch = "wasm32")]
mod wasm_cut;
#[cfg(target_arch = "wasm32")]
mod wasm_math;

pub use attributes::{DecodedPage, Layout, OPTIONAL};
use bits::Quant;

pub const MAGIC: u32 = 0x3350_4757;
pub const VERSION: u32 = 3;
/// Twenty-four little-endian words open a page: counts, flags, the quantization records of the
/// four vector attributes, the error, and three reserved words that must read zero.
pub const HEADER_WORDS: usize = 24;
pub const HEADER_BYTES: usize = HEADER_WORDS * 4;
pub const MAX_VERTICES: usize = 65_535;
/// Attribute presence bits: normal, first and second texture coordinate, colour.
pub const FLAG_NORMAL: u32 = 1;
pub const FLAG_UV: u32 = 2;
pub const FLAG_UV1: u32 = 4;
pub const FLAG_COLOR: u32 = 8;
pub const FLAGS_ALL: u32 = 15;

/// Refusal causes, in the order the JavaScript decoder raises them. The numeric values cross the
/// WebAssembly ABI: the JS loader retranslates them into `GEOMETRY_PAGE_*` messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum PageError {
    Header = 1,
    Version = 2,
    Bounds = 3,
    Index = 4,
}

/// A page header, once its twenty-four words have been read and every bound accepted.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Header {
    pub vertex_count: usize,
    pub index_count: usize,
    pub flags: u32,
    pub position: Quant<3>,
    pub uv: Quant<2>,
    pub uv1: Quant<2>,
    /// Colour on a fixed grid of 2^-8: a constant channel costs no bits.
    pub color: Quant<4>,
    /// Largest distance, in object units, between a source position and its decoded value.
    pub quantization_error: f32,
}

impl Header {
    /// Floats per decoded vertex: position, then each present attribute at its width.
    pub fn vertex_floats(&self) -> usize {
        3 + OPTIONAL
            .iter()
            .filter(|(bit, _)| self.flags & bit != 0)
            .map(|(_, size)| size)
            .sum::<usize>()
    }

    /// Bytes of the decoded page: float attributes and 32-bit indices. Saturating, since a
    /// forged count would otherwise wrap a 32-bit `usize` back under the budget and let the
    /// decoder trap on its allocation instead of refusing the header.
    pub fn decoded_bytes(&self) -> usize {
        self.vertex_count
            .saturating_mul(self.vertex_floats() * 4)
            .saturating_add(self.index_count.saturating_mul(4))
    }

    /// The header as its words, the exact inverse of `parse`.
    pub fn words(&self) -> [u32; HEADER_WORDS] {
        let mut w = [0u32; HEADER_WORDS];
        w[..5].copy_from_slice(&[
            MAGIC,
            VERSION,
            self.vertex_count as u32,
            self.index_count as u32,
            self.flags,
        ]);
        w[5] = self.position.packed();
        w[6..9].copy_from_slice(&self.position.min.map(f32::to_bits));
        w[9] = self.uv.packed();
        w[10..12].copy_from_slice(&self.uv.min.map(f32::to_bits));
        w[12] = self.uv1.packed();
        w[13..15].copy_from_slice(&self.uv1.min.map(f32::to_bits));
        w[15] = self.color.packed();
        w[16..20].copy_from_slice(&self.color.min.map(f32::to_bits));
        w[20] = self.quantization_error.to_bits();
        w
    }

    /// The header words and the JS decoder's bounds, refused in the same order; the byte
    /// length must be exactly what the streams need and the decoded page under the budget.
    pub fn parse(data: &[u8], max_decoded_bytes: usize) -> Result<Self, PageError> {
        if data.len() < HEADER_BYTES {
            return Err(PageError::Header);
        }
        let w = header_words(&data[..HEADER_BYTES]);
        if w[0] != MAGIC || w[1] != VERSION {
            return Err(PageError::Version);
        }
        let f = f32::from_bits;
        let records = (
            Quant::unpack(w[5], [f(w[6]), f(w[7]), f(w[8])]),
            Quant::unpack(w[9], [f(w[10]), f(w[11])]),
            Quant::unpack(w[12], [f(w[13]), f(w[14])]),
            Quant::unpack(w[15], [f(w[16]), f(w[17]), f(w[18]), f(w[19])]),
        );
        let (Some(position), Some(uv), Some(uv1), Some(color)) = records else {
            return Err(PageError::Bounds);
        };
        let header = Self {
            vertex_count: w[2] as usize,
            index_count: w[3] as usize,
            flags: w[4],
            position,
            uv,
            uv1,
            color,
            quantization_error: f(w[20]),
        };
        let sane = w[21..].iter().all(|&word| word == 0)
            && (1..=MAX_VERTICES).contains(&header.vertex_count)
            && (3..=max_decoded_bytes / 4).contains(&header.index_count)
            && header.index_count.is_multiple_of(3)
            && header.flags & !FLAGS_ALL == 0
            && header.quantization_error.is_finite()
            && header.quantization_error >= 0.0
            && header.decoded_bytes() <= max_decoded_bytes
            && Layout::of(&header).bytes() == data.len();
        if !sane {
            return Err(PageError::Bounds);
        }
        Ok(header)
    }
}

/// The twenty-four little-endian words of a header.
fn header_words(bytes: &[u8]) -> [u32; HEADER_WORDS] {
    let mut w = [0u32; HEADER_WORDS];
    for (word, chunk) in w.iter_mut().zip(bytes.as_chunks::<4>().0) {
        *word = u32::from_le_bytes(*chunk);
    }
    w
}

/// A complete page, its streams unpacked and dequantized: the same bytes as `decodeGeometryPage`.
/// The streams are read in place when the page sits on a word boundary — a `page_alloc`
/// reservation always does — and from a copy otherwise.
pub fn decode(data: &[u8], max_decoded_bytes: usize) -> Result<DecodedPage, PageError> {
    let header = Header::parse(data, max_decoded_bytes)?;
    let body = &data[HEADER_BYTES..];
    // SAFETY: every bit pattern is a valid `u32`; the byte count is a multiple of four, so an
    // empty head leaves no tail. Only a little-endian host may read the words as they lie.
    let (head, aligned, _) = unsafe { body.align_to::<u32>() };
    let copied: Vec<u32>;
    let words = if cfg!(target_endian = "little") && head.is_empty() {
        aligned
    } else {
        copied = body
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| u32::from_le_bytes(*b))
            .collect();
        &copied
    };
    attributes::split(words, &header)
}

#[cfg(test)]
#[path = "header_tests.rs"]
mod header_tests;
