use super::tests::{column, sample, TEMPLATES};
use super::*;

/// The four numbers page `page` writes in the cone column.
fn cone_of(bytes: &[u8], page: usize) -> Vec<f64> {
    column(bytes, PAGE_CONE)[page * 32..page * 32 + 32]
        .chunks(8)
        .map(|word| f64::from_le_bytes(word.try_into().unwrap()))
        .collect()
}

// Behaviour: a cooked cone is written as its four numbers, bit for bit; a page that names none,
// as a hand-written manifest may, is given the cone that rejects nothing.
#[test]
fn every_page_writes_its_cone_and_a_page_without_one_writes_the_open_cone() {
    let mut manifest = sample();
    let axis = [
        -0.0621135613999339,
        0.027174688463389093,
        0.9976990737678042,
    ];
    let angle: f64 = 1.7498532116605978;
    manifest["primitives"][0]["pages"][0]["cone"] = json!({"axis": axis, "angle": angle});
    let (_, bytes) = split(&manifest, &TEMPLATES, &[]).expect("split");
    let cone = cone_of(&bytes, 0);
    assert_eq!(cone[..3], axis);
    assert_eq!(cone[3].to_bits(), angle.to_bits());
    assert_eq!(
        cone_of(&bytes, 1),
        trillion3d_page_codec::normal_cone::OPEN_CONE
    );
}

#[test]
fn a_cone_without_three_axis_numbers_is_refused() {
    let mut manifest = sample();
    manifest["primitives"][0]["pages"][0]["cone"] = json!({"axis": [0.0, 1.0], "angle": 0.5});
    let error = split(&manifest, &TEMPLATES, &[]).unwrap_err();
    assert_eq!(error.code, "INVALID_MANIFEST");
    assert!(
        error.message.contains("page.cone.axis"),
        "{}",
        error.message
    );
}
