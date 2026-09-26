use super::*;
/// The object templates every test of the sidecar splits with.
pub(super) const TEMPLATES: Templates = Templates {
    page: "../../objects/{sha}.bin",
    geometry: "../../objects/{sha}.bin",
    bundle: "../../objects/{sha}.bin",
};
/// Splits a finished manifest into the small JSON and the columns, as `columns` does.
pub(super) fn split(m: &Value, t: &Templates, pv: &[TexturePreview]) -> Result<(Value, Vec<u8>)> {
    let mut top = m.as_object().cloned().unwrap_or_default();
    let primitives = top.remove("primitives").unwrap_or_default();
    let primitives = primitives.as_array().map_or(&[][..], Vec::as_slice);
    columns(&top, primitives, t, pv)
}
/// The bytes of column `index` of a finished sidecar.
pub(super) fn column(bytes: &[u8], index: usize) -> &[u8] {
    let at = (HEADER_WORDS + index * 2) * 4;
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    &bytes[word(at)..word(at) + word(at + 4)]
}
fn sha(c: char) -> String {
    std::iter::repeat_n(c, 64).collect()
}
fn exact_page() -> Value {
    let mut page = json!({"id":0,"bytes":48,"count":12,"start":0,"min":[0.,0.,0.],"max":[1.,1.,1.],"role":"exact","level":0});
    page["url"] = json!(format!("../../objects/{}.bin", sha('a')));
    page["sha256"] = json!(sha('a'));
    page["lodError"] = json!(0.0);
    page["sphere"] = json!([0.5, 0.5, 0.5, 0.9]);
    page["parentError"] = json!(0.25);
    page["parentSphere"] = json!([1., 2., 3., 4.]);
    page["group"] = json!(0);
    page["source"] = Value::Null;
    page["stream"] = json!(0);
    page["streamOffset"] = json!(0);
    let mut geometry =
        json!({"bytes":32,"vertexCount":8,"indexCount":12,"flags":1,"uncompressedBytes":128});
    geometry["url"] = json!(format!("../../objects/{}.bin", sha('b')));
    geometry["sha256"] = json!(sha('b'));
    page["geometry"] = geometry;
    page
}
fn coarse_page() -> Value {
    let mut page = json!({"id":1,"bytes":48,"count":12,"start":0,"min":[0.,0.,0.],"max":[1.,1.,1.],"role":"coarse","level":1});
    page["url"] = json!(format!("../../objects/{}.bin", sha('d')));
    page["sha256"] = json!(sha('d'));
    page["lodError"] = json!(0.25);
    page["sphere"] = json!([0.5, 0.5, 0.5, 0.9]);
    page["parentError"] = Value::Null;
    page["parentSphere"] = Value::Null;
    page["group"] = Value::Null;
    page["source"] = json!(0);
    page["stream"] = json!(0);
    page["streamOffset"] = json!(48);
    page
}
pub(super) fn sample() -> Value {
    let mut bundle = json!({"bytes":96,"count":2,"dependencies":[]});
    bundle["url"] = json!(format!("../../objects/{}.bin", sha('c')));
    bundle["sha256"] = json!(sha('c'));
    let mut primitive =
        json!({"mesh":0,"primitive":0,"pass":"exact-clusters","hierarchy":Value::Null});
    primitive["culling"] =
        json!({"stride":crate::CULLING_STRIDE,"count":1,"nodes":vec![0.5;crate::CULLING_STRIDE]});
    primitive["structure"] = json!({"version":1,"roots":[1],"groups":[{"level":1,"error":0.25,"sphere":[1.,2.,3.,4.],"children":[0],"outputs":[1]}]});
    primitive["streams"] = json!({"version":1,"pinned":1,"bundleBytes":131072,"dependencyBound":0,"maxDependencies":0,"pages":[bundle]});
    primitive["pages"] = json!([exact_page(), coarse_page()]);
    json!({"schema":2,"formatVersion":2,"status":"ready","primitives":[primitive]})
}
#[test]
fn digests_reads_back_every_sha_column() {
    let manifest = sample();
    let (_, bytes) = split(&manifest, &TEMPLATES, &[]).expect("split");
    let mut found = digests(&bytes).expect("digests");
    found.sort();
    found.dedup();
    let mut expected = vec![sha('a'), sha('b'), sha('c'), sha('d')];
    expected.sort();
    assert_eq!(found, expected);
    assert!(digests(&bytes[..12]).is_err());
}
// Behaviour: a column entry that is not a digest names no object — the reader
// refuses it, so neither the proof nor prune ever forms a path from it.
#[test]
fn a_sha_column_entry_that_is_not_a_digest_is_refused() {
    let (_, mut bytes) = split(&sample(), &TEMPLATES, &[]).expect("split");
    let at = bytes
        .windows(64)
        .position(|window| window == sha('a').as_bytes())
        .expect("page digest column");
    bytes[at..at + 3].copy_from_slice(b"../");
    assert_eq!(
        digests(&bytes).unwrap_err().message,
        "Digest column entry is not a digest"
    );
}
#[test]
fn columns_declare_their_own_offsets_and_lengths() {
    let (slim, bytes) = split(&sample(), &TEMPLATES, &[]).expect("split");
    assert_eq!(
        u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
        MANIFEST_BINARY_MAGIC
    );
    assert_eq!(
        u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
        MANIFEST_BINARY_VERSION
    );
    assert_eq!(
        u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
        COLUMNS as u32
    );
    let read = |index: usize| {
        let at = (HEADER_WORDS + index * 2) * 4;
        (
            u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize,
            u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize,
        )
    };
    let mut previous = (HEADER_WORDS + COLUMNS * 2) * 4;
    for index in 0..COLUMNS {
        let (offset, length) = read(index);
        assert_eq!(offset % 8, 0, "column {index} is not eight-byte aligned");
        assert!(
            offset >= previous && offset + length <= bytes.len(),
            "column {index} is out of bounds"
        );
        previous = offset + length;
    }
    // Two pages, six bounds each, eight bytes a number.
    assert_eq!(read(PAGE_BOUNDS).1, 2 * 6 * 8);
    assert_eq!(read(PAGE_SHA).1, 2 * 64);
    assert_eq!(read(CULLING_NODES).1, crate::CULLING_STRIDE * 8);
    assert_eq!(read(GROUP_CHILD).1, 4);
    assert_eq!(read(BUNDLE_SHA).1, 64);
    // The small JSON keeps the counts and loses the arrays.
    let primitive = slim["primitives"][0].as_object().unwrap();
    assert!(primitive.get("pages").is_none() && primitive.get("culling").is_none());
    assert_eq!(primitive["binary"]["pages"], json!(2));
    assert_eq!(primitive["binary"]["structure"]["groups"], json!(1));
    assert_eq!(primitive["binary"]["streams"]["pages"], json!(1));
    assert_eq!(slim["binary"]["bytes"], json!(bytes.len()));
}
#[test]
fn a_url_that_leaves_the_template_is_refused() {
    let mut manifest = sample();
    manifest["primitives"][0]["pages"][0]["url"] = json!("pages/0.bin");
    assert_eq!(
        split(&manifest, &TEMPLATES, &[]).unwrap_err().code,
        "INVALID_MANIFEST"
    );
}
// Behavior 10 (Rust): encoding refuses depthLayer exceeding four bits (> 15).
#[test]
fn split_rejects_a_depth_layer_that_exceeds_four_bits() {
    let mut manifest = sample();
    manifest["primitives"][0]["pages"][0]["depthLayer"] = json!(16);
    let error = split(&manifest, &TEMPLATES, &[]).unwrap_err();
    assert_eq!(error.code, "INVALID_MANIFEST");
    assert!(
        error.message.contains("depthLayer"),
        "message must name the offending field: {}",
        error.message
    );
}
#[test]
fn split_accepts_a_depth_layer_at_the_four_bit_limit_and_writes_it_in_its_column() {
    let mut manifest = sample();
    manifest["primitives"][0]["pages"][0]["depthLayer"] = json!(15);
    let (_, bytes) = split(&manifest, &TEMPLATES, &[]).expect("split");
    let at = (HEADER_WORDS + PAGE_DEPTH_LAYER * 2) * 4;
    let offset = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    let first_page_layer = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    assert_eq!(first_page_layer, 15);
    // Second page (coarse_page) carries no depthLayer: column stays zero.
    let second_page_layer = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap());
    assert_eq!(second_page_layer, 0);
}
